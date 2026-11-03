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
// mercado.json pode faltar se a brapi e o Yahoo caírem juntos: sem ele, só não sai o aviso de fechamento
const mercado = (() => { try { return ler('mercado.json'); } catch { return {}; } })();
const noticias = ler('noticias.json').n || [];
const fundamentos = ler('fundamentos.json').a || {};
const videos = ler('videos.json');

const agora = new Date();
const brt = new Date(agora.getTime() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
// ponto de milhar só na parte inteira ("R$ 1.234,5678", nunca "R$ 0,2.025")
const reais = (v, c = 2) => { const [i, d] = v.toFixed(c).split('.'); return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${d ? ',' + d : ''}`; };
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
async function guardar(uid, e, alertasAtivos) {
  // guarda só os últimos 15 dias; alerta de preço que já disparou fica guardado enquanto existir na conta
  // (senão voltaria a avisar a cada 15 dias com o preço ainda além do alvo)
  const corte = Date.now() - 15 * 86400 * 1000;
  const limpo = Object.fromEntries(Object.entries(e).filter(([k, t]) => t > corte || alertasAtivos.has(k)));
  await fetch(`${FS}/avisos/${uid}?updateMask.fieldPaths=e`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { e: paraFs(limpo) } }) });
}
// chaves dos alertas de preço que ainda existem na conta (ficam guardadas mesmo depois de 15 dias)
const alertasDe = (u) => new Set(Object.entries(u.alertas || {}).flatMap(([tk, als]) => (als || []).filter((a) => a.tipo === 'preco').map((a) => `alerta:${tk}:${a.dir}:${a.valor}`)));

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

// dia de pregão: dia útil, fora dos feriados da B3 (calendario.json) e com cotação de hoje
const feriado = (() => { try { return ler('calendario.json').some((e) => e.d === hoje && /Sem pregão/.test(e.t)); } catch { return false; } })();
const pregaoHoje = brt.getUTCDay() % 6 !== 0 && !feriado && !!mercado.atualizadoEm && new Date(new Date(mercado.atualizadoEm).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) === hoje;

// ---------- o que cada pessoa deve receber agora ----------
function avisosDe(u, ja, primeira) {
  const n = u.notif || {};
  const watch = u.watch || [];
  const qtd = u.qtd || {};
  const lista = [];
  const add = (chave, titulo, texto, dados = {}) => { if (!ja[chave] && !lista.some((x) => x.chave === chave)) lista.push({ chave, titulo, texto, dados }); };

  // alertas de preço: preço alvo vai uma vez; variação vai no máximo uma vez por dia
  if (n.alertas !== false) {
    for (const [tk, als] of Object.entries(u.alertas || {})) {
      const q = cot[tk];
      if (!q) continue;
      const [preco, v] = q;
      for (const al of als || []) {
        if (al.tipo === 'preco' && ((al.dir === 'acima' && preco >= al.valor) || (al.dir === 'abaixo' && preco <= al.valor)))
          add(`alerta:${tk}:${al.dir}:${al.valor}`, `${tk} chegou a ${reais(preco)}`, `Seu alerta era ${al.dir === 'acima' ? 'subir até' : 'cair até'} ${reais(al.valor)}.`, { tk });
        // variação só em dia de pregão e depois das 10h15 (antes disso a cotação ainda é a do pregão anterior)
        if (al.tipo === 'var' && pregaoHoje && minutos >= 10 * 60 + 15 && Math.abs(v) >= al.valor)
          add(`var:${tk}:${al.valor}:${hoje}`, `${tk} ${v >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(v)).replace('+', '')} hoje`, `Passou dos ${al.valor.toString().replace('.', ',')}% do seu alerta. Está em ${reais(preco)}.`, { tk });
      }
    }
  }
  // notícia nova dos ativos da pessoa (na primeira vez, só da última hora; depois, das últimas 16 horas,
  // pra de manhã pegar o que saiu à noite, quando o robô não roda)
  if (n.noticias !== false) {
    const avisar = u.avisoNoticia || {};
    const limite = new Date(agora.getTime() - (primeira ? 1 : 16) * 3600 * 1000);
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
      // junta o que tem a mesma data com e de pagamento (JCP + dividendo, parcelas iguais), como o app
      const juntos = new Map();
      for (const [com, pag, v, tipo] of fundamentos[tk]?.p || []) {
        const k = `${com}|${pag}`;
        const ja2 = juntos.get(k);
        if (ja2) { ja2.v += v; if (!ja2.tipos.includes(tipo)) ja2.tipos.push(tipo); } else juntos.set(k, { com, pag, v, tipos: [tipo] });
      }
      const un = tk.endsWith('11') ? 'cota' : 'ação';
      for (const { com, pag, v, tipos } of juntos.values()) {
        const tipoTxt = tipos.join(' + ').toLowerCase();
        if (com === hoje) add(`com:${tk}:${com}:${pag}`, `${tk}: hoje é a data com`, `Quem tiver ${tk} no fim do dia recebe ${provTxt(v)} por ${un} (${tipoTxt})${pag ? `, pago em ${dataCurta(pag)}` : ''}.`, { tk });
        if (pag === hoje) add(`pag:${tk}:${com}:${pag}`, `${tk} paga hoje`, `${provTxt(v)} por ${un} (${tipoTxt})` + (qtd[tk] > 0 ? `: ${reais(v * qtd[tk])} pra você.` : '.'), { tk });
      }
    }
  }
  // fechamento: rodada das 18h30, só em dia de pregão (a B3 fecha às 17h ou às 18h, conforme o horário de verão
  // dos EUA, e a cotação pode ter até 30 min de atraso)
  if (n.fechamento !== false && minutos >= 18 * 60 + 30 && pregaoHoje && mercado.ibov) {
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

// contas do dono: lista de uids em config/avisos.donos no Firestore (privado; o app não lê config)
async function lerDonos() {
  const r = await fetch(`${FS}/config/avisos`, { headers: H });
  return new Set(r.ok ? valor({ mapValue: { fields: (await r.json()).fields || {} } }).donos || [] : []);
}

// ---------- roda ----------
// o mesmo celular em duas contas (alguém saiu sem apagar o registro): vale só a conta registrada por último
const todas = (await contas()).filter((u) => u.push?.token);

// teste manual (rodar o robô com "aviso de teste" = 1): manda um aviso só, pra cada celular registrado
if (process.env.TESTE === '1') {
  let ok = 0;
  for (const u of todas) {
    const r = await mandar(u.push.token, 'Teste da InfoBolsa', 'Se você está lendo isto, os avisos no celular estão funcionando. Toque pra abrir o app.', { tela: 'hoje' });
    console.log(`teste para ${u.uid.slice(0, 6)}…: ${r}`);
    if (r === 'ok') ok++;
  }
  console.log(`ok: aviso de teste mandado para ${ok} de ${todas.length} celular(es)`);
  process.exit(0);
}

// recado da InfoBolsa (lançamento, aviso geral), disparado à mão pelo workflow com título, texto e link opcional.
// "teste" vai só pra conta do dono; "todos" vai pra quem deixou "Novidades" ligado.
// O mesmo recado não vai duas vezes pra mesma pessoa.
const recado = { titulo: (process.env.RECADO_TITULO || '').trim(), texto: (process.env.RECADO_TEXTO || '').trim(), link: (process.env.RECADO_LINK || '').trim(), para: process.env.RECADO_PARA || 'teste' };
if (recado.titulo && recado.texto) {
  const donos = await lerDonos();
  const alvo = todas.filter((u) => (recado.para === 'todos' ? u.notif?.novidades !== false : donos.has(u.uid)));
  const chave = `recado:${(recado.titulo + recado.texto).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60)}`;
  const dados = recado.link && /^https:\/\//.test(recado.link) ? { url: recado.link } : { tela: 'hoje' };
  let ok = 0, ja = 0;
  for (const u of alvo) {
    const e = { ...((await enviados(u.uid)) || {}) };
    if (recado.para === 'todos' && e[chave]) { ja++; continue; }
    const r = await mandar(u.push.token, recado.titulo, recado.texto, dados);
    if (r === 'sem-endereco') { await tirarEndereco(u.uid); continue; }
    if (r !== 'ok') { console.log(`recado não foi: ${r}`); continue; }
    ok++;
    if (recado.para === 'todos') { e[chave] = Date.now(); await guardar(u.uid, e, alertasDe(u)); }
  }
  console.log(`ok: recado (${recado.para}) mandado para ${ok} de ${alvo.length} celular(es)${ja ? `, ${ja} já tinham recebido` : ''}`);
  process.exit(0);
}
// problemas e sugestões mandados pelo app (coleção sugestoes): avisa o dono e marca como avisado
const TIPO_SUG = { problema: 'Problema relatado', sugestao: 'Sugestão nova', outro: 'Mensagem nova' };
try {
  const r = await fetch(`${FS}:runQuery`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'sugestoes' }], where: { fieldFilter: { field: { fieldPath: 'avisado' }, op: 'EQUAL', value: { booleanValue: false } } }, limit: 30 } }),
  });
  if (!r.ok) throw new Error(`Firestore sugestoes: ${r.status} ${await r.text()}`);
  const novas = (await r.json()).filter((x) => x.document).map((x) => ({ nome: x.document.name, ...valor({ mapValue: { fields: x.document.fields || {} } }) }));
  if (novas.length) {
    const donos = await lerDonos();
    const celulares = todas.filter((u) => donos.has(u.uid));
    const lista = novas.length > 3
      ? [{ titulo: `${novas.length} mensagens novas no app`, texto: novas.map((n) => `${TIPO_SUG[n.tipo] || 'Mensagem'}: ${n.texto.slice(0, 60)}`).join('\n') }]
      : novas.map((n) => ({ titulo: `${TIPO_SUG[n.tipo] || 'Mensagem nova'} no app`, texto: `${n.texto.slice(0, 400)}${n.responder && n.email ? '\n(pediu resposta por e-mail)' : ''}` }));
    let ok = 0;
    for (const u of celulares) for (const m of lista) if ((await mandar(u.push.token, m.titulo, m.texto, { tela: 'perfil' })) === 'ok') ok++;
    // sem celular do dono registrado, deixa pra próxima rodada
    if (ok) for (const n of novas) await fetch(`https://firestore.googleapis.com/v1/${n.nome}?updateMask.fieldPaths=avisado`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { avisado: { booleanValue: true } } }) });
    console.log(`ok: ${novas.length} sugestão(ões) nova(s), ${ok} aviso(s) pro dono`);
  }
} catch (e) { console.log(`sugestões: ${e.message}`); }

const donoDoToken = new Map();
for (const u of todas) {
  const atual = donoDoToken.get(u.push.token);
  if (!atual || (u.push.em || '') > (atual.push.em || '')) donoDoToken.set(u.push.token, u);
}
let mandados = 0, pessoas = 0;
for (const u of todas) {
  if (donoDoToken.get(u.push.token) !== u) continue;
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
  if (mudou) await guardar(u.uid, ja, alertasDe(u));
}
console.log(`ok: ${mandados} aviso(s) para ${pessoas} pessoa(s) com notificação ligada`);
