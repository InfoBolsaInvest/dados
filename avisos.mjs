// Avisos no celular (toda rodada). Lê as contas no Firestore e manda pelo Firebase Cloud Messaging:
//   alerta de preço (chegou no valor) e de variação no dia, notícia nova dos ativos da pessoa,
//   data com e dia de pagamento de provento, fechamento do mercado e vídeo novo do canal.
// Cada aviso vai uma vez só: o que já foi mandado fica em avisos/{uid} (coleção que o app não lê).
// O acesso ao Google vem do GitHub sem chave guardada (Workload Identity Federation): GOOGLE_TOKEN.
import { readFileSync } from 'node:fs';

const PROJETO = 'infobolsa-investimentos';
const TOKEN = process.env.GOOGLE_TOKEN;
if (!TOKEN) { console.log('sem GOOGLE_TOKEN: pulei os avisos'); process.exit(0); }
const FS = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const POR_RODADA = 5; // máximo de avisos por pessoa a cada 15 minutos

const ler = (f) => JSON.parse(readFileSync(`site/${f}`, 'utf8'));
const cot = ler('cotacoes.json').q;
const mercado = ler('mercado.json');
const noticias = ler('noticias.json').n || [];
const fundamentos = ler('fundamentos.json').a || {};
const videos = ler('videos.json');

const agora = new Date();
const brt = new Date(agora.getTime() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
const reais = (v, c = 2) => 'R$ ' + v.toFixed(c).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
// provento abaixo de R$ 1 com até 4 casas (R$ 0,095), igual ao app
const provTxt = (v) => { let c = v >= 1 ? 2 : 4; while (c > 2 && Math.round(v * 10 ** c) % 10 === 0) c--; return reais(v, c); };
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}%`;
const dataCurta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ---------- Firestore (formato com tipos) ----------
function valor(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, valor(x)]));
  return null;
}
const paraFs = (o) => ({ mapValue: { fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { integerValue: String(v) }])) } });

async function contas() {
  const out = [];
  let pagina = '';
  do {
    const r = await fetch(`${FS}/usuarios?pageSize=300${pagina ? `&pageToken=${pagina}` : ''}`, { headers: H });
    if (!r.ok) throw new Error(`Firestore usuarios: ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const d of j.documents || []) out.push({ uid: d.name.split('/').pop(), ...valor({ mapValue: { fields: d.fields || {} } }) });
    pagina = j.nextPageToken || '';
  } while (pagina);
  return out;
}
async function enviados(uid) {
  const r = await fetch(`${FS}/avisos/${uid}`, { headers: H });
  if (r.status === 404) return null; // primeira vez: não manda o que é antigo
  if (!r.ok) throw new Error(`Firestore avisos: ${r.status}`);
  return valor({ mapValue: { fields: (await r.json()).fields || {} } }).e || {};
}
async function guardar(uid, e) {
  // guarda só os últimos 15 dias
  const corte = Date.now() - 15 * 86400 * 1000;
  const limpo = Object.fromEntries(Object.entries(e).filter(([, t]) => t > corte));
  await fetch(`${FS}/avisos/${uid}?updateMask.fieldPaths=e`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { e: paraFs(limpo) } }) });
}
async function tirarEndereco(uid) {
  await fetch(`${FS}/usuarios/${uid}?updateMask.fieldPaths=push`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: {} }) });
}

// ---------- Firebase Cloud Messaging ----------
async function mandar(token, titulo, texto, dados) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJETO}/messages:send`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: { token, notification: { title: titulo, body: texto }, data: dados, android: { priority: 'high', notification: { channel_id: 'avisos', color: '#FFB400' } } } }),
  });
  if (r.ok) return 'ok';
  const erro = await r.text();
  return /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(erro) ? 'sem-endereco' : `erro ${r.status}`;
}

// ---------- o que cada pessoa deve receber agora ----------
function avisosDe(u, ja, primeira) {
  const n = u.notif || {};
  const watch = u.watch || [];
  const qtd = u.qtd || {};
  const lista = [];
  const add = (chave, titulo, texto, dados = {}) => { if (!ja[chave]) lista.push({ chave, titulo, texto, dados }); };

  // alertas de preço: preço alvo vai uma vez; variação vai no máximo uma vez por dia
  if (n.alertas !== false) {
    for (const [tk, als] of Object.entries(u.alertas || {})) {
      const q = cot[tk];
      if (!q) continue;
      const [preco, v] = q;
      for (const al of als || []) {
        if (al.tipo === 'preco' && ((al.dir === 'acima' && preco >= al.valor) || (al.dir === 'abaixo' && preco <= al.valor)))
          add(`alerta:${tk}:${al.dir}:${al.valor}`, `${tk} chegou a ${reais(preco)}`, `Seu alerta era ${al.dir === 'acima' ? 'subir até' : 'cair até'} ${reais(al.valor)}.`, { tk });
        if (al.tipo === 'var' && Math.abs(v) >= al.valor)
          add(`var:${tk}:${al.valor}:${hoje}`, `${tk} ${v >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(v)).replace('+', '')} hoje`, `Passou dos ${al.valor.toString().replace('.', ',')}% do seu alerta. Está em ${reais(preco)}.`, { tk });
      }
    }
  }
  // notícia nova dos ativos da pessoa (na primeira vez, só da última hora)
  if (n.noticias !== false) {
    const avisar = u.avisoNoticia || {};
    const limite = new Date(agora.getTime() - (primeira ? 1 : 3) * 3600 * 1000);
    const novas = noticias.filter((x) => {
      const tk = x.t.find((t) => watch.includes(t) && avisar[t] !== false);
      if (!tk) return false;
      const [hh, mm] = x.h.split('h').map(Number);
      return new Date(`${x.d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`) >= limite;
    });
    const chave = (x) => `n:${x.ti.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60)}`;
    const ineditas = novas.filter((x) => !ja[chave(x)]);
    if (ineditas.length > 2) {
      const tks = [...new Set(ineditas.flatMap((x) => x.t.filter((t) => watch.includes(t))))].slice(0, 3);
      lista.push({ chave: '', marcar: ineditas.map(chave), titulo: `${ineditas.length} notícias dos seus ativos`, texto: `Sobre ${tks.join(', ')}. Toque pra ver no app.`, dados: { tela: 'hoje' } });
    } else {
      for (const x of ineditas) {
        const tk = x.t.find((t) => watch.includes(t));
        add(chave(x), `${tk} nas notícias`, `${x.ti} (${x.f})`, { tk });
      }
    }
  }
  // provento: data com (a partir das 10h) e dia do pagamento
  if (n.proventos !== false && minutos >= 10 * 60) {
    for (const tk of watch) {
      for (const [com, pag, v, tipo] of fundamentos[tk]?.p || []) {
        const un = tk.endsWith('11') ? 'cota' : 'ação';
        if (com === hoje) add(`com:${tk}:${com}:${v}`, `${tk}: hoje é a data com`, `Quem tiver ${tk} no fim do dia recebe ${provTxt(v)} por ${un} (${tipo.toLowerCase()})${pag ? `, pago em ${dataCurta(pag)}` : ''}.`, { tk });
        if (pag === hoje) add(`pag:${tk}:${pag}:${v}`, `${tk} paga hoje`, `${provTxt(v)} por ${un}` + (qtd[tk] > 0 ? `: ${reais(v * qtd[tk])} pra você.` : '.'), { tk });
      }
    }
  }
  // fechamento: primeira rodada depois das 17h30, só em dia de pregão
  // dia de pregão: dia útil, fora dos feriados da B3 (calendario.json) e com cotação de hoje
const feriado = ler('calendario.json').some((e) => e.d === hoje && /Sem pregão/.test(e.t));
const pregaoHoje = brt.getUTCDay() % 6 !== 0 && !feriado && mercado.atualizadoEm && new Date(new Date(mercado.atualizadoEm).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) === hoje;
  if (n.fechamento !== false && minutos >= 17 * 60 + 30 && pregaoHoje && mercado.ibov) {
    const [pts, v] = mercado.ibov;
    const dol = mercado.mundo?.USD || mercado.dolar;
    add(`fech:${hoje}`, `Fechamento: Ibovespa ${v >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(v)).replace('+', '')}`, `Aos ${Math.round(pts).toLocaleString('pt-BR')} pontos.` + (dol ? ` Dólar a ${reais(dol[0])}.` : ''), { tela: 'hoje' });
  }
  // vídeo novo do canal (dos últimos 2 dias)
  if (n.videos) {
    const doisDias = new Date(brt.getTime() - 2 * 86400 * 1000).toISOString().slice(0, 10);
    for (const vid of videos.filter((x) => x.d >= doisDias)) add(`v:${vid.id}`, 'Vídeo novo no canal da InfoBolsa', vid.t, { tela: 'videos' });
  }
  return lista;
}

// ---------- roda ----------
const todas = await contas();
let mandados = 0, pessoas = 0;
for (const u of todas) {
  if (!u.push?.token) continue;
  pessoas++;
  const antes = await enviados(u.uid);
  const ja = { ...(antes || {}) };
  const lista = avisosDe(u, ja, antes === null);
  let mudou = antes === null;
  for (const a of lista.slice(0, POR_RODADA)) {
    const r = await mandar(u.push.token, a.titulo, a.texto, Object.fromEntries(Object.entries(a.dados).map(([k, v]) => [k, String(v)])));
    if (r === 'sem-endereco') { await tirarEndereco(u.uid); break; }
    if (r !== 'ok') { console.log(`aviso não foi: ${r}`); continue; }
    for (const k of [a.chave, ...(a.marcar || [])].filter(Boolean)) ja[k] = Date.now();
    mandados++;
    mudou = true;
  }
  if (mudou) await guardar(u.uid, ja);
}
console.log(`ok: ${mandados} aviso(s) para ${pessoas} pessoa(s) com notificação ligada`);
