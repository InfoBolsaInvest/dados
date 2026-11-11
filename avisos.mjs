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
const TODAS_POR_RODADA = 12; // quem ligou "Todas as notícias": até 12 por rodada, além dos outros; o resto vai num aviso só
// hora da notícia ("14h20" do dia d, horário de Brasília) em milissegundos
const horaNoticia = (x) => { const [hh, mm] = String(x.h || '0h0').split('h').map(Number); return Date.parse(`${x.d}T${String(hh || 0).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00-03:00`); };

const ler = (f) => JSON.parse(readFileSync(`site/${f}`, 'utf8'));
const cot = ler('cotacoes.json').q;
// mercado.json pode faltar se a brapi e o Yahoo caírem juntos: sem ele, só não sai o aviso de fechamento
const mercado = (() => { try { return ler('mercado.json'); } catch { return {}; } })();
const noticias = ler('noticias.json').n || [];
const fundamentos = ler('fundamentos.json').a || {};
const videos = ler('videos.json');
// resumo do fechamento de hoje (resumo.mjs): o aviso de fechamento abre o resumo no app
const temResumo = (() => { try { return ler('resumo.json').d === new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); } catch { return false; } })();

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
// os últimos avisos de cada pessoa (o sininho do app mostra): lidos junto com o "já mandado"
const HIST = new Map();
const HIST_MAX = 40;
async function enviados(uid) {
  const r = await fetch(`${FS}/avisos/${uid}`, { headers: H });
  if (r.status === 404) { HIST.set(uid, []); return null; } // primeira vez: não manda o que é antigo
  if (!r.ok) throw new Error(`Firestore avisos: ${r.status}`);
  const doc = valor({ mapValue: { fields: (await r.json()).fields || {} } });
  HIST.set(uid, Array.isArray(doc.h) ? doc.h : []);
  return doc.e || {};
}
// valor no formato do Firestore, com texto, número, lista e mapa
function fs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fs(x)])) } };
}
// guarda no histórico o que acabou de chegar no celular (mais novo primeiro): t título, x texto, em quando, d para onde
// o toque leva (tela, ativo, resumo)
async function anotar(uid, itens) {
  if (!itens.length) return;
  const h = [...itens.map((a) => ({ t: a.titulo, x: a.texto, em: Date.now(), d: a.dados || {} })), ...(HIST.get(uid) || [])].slice(0, HIST_MAX);
  HIST.set(uid, h);
  await fetch(`${FS}/avisos/${uid}?updateMask.fieldPaths=h`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { h: fs(h) } }) });
}
async function guardar(uid, e, alertasAtivos) {
  // guarda só os últimos 15 dias; alerta de preço que já disparou fica guardado enquanto existir na conta
  // (senão voltaria a avisar a cada 15 dias com o preço ainda além do alvo)
  const corte = Date.now() - 15 * 86400 * 1000;
  const limpo = Object.fromEntries(Object.entries(e).filter(([k, t]) => t > corte || alertasAtivos.has(k)));
  await fetch(`${FS}/avisos/${uid}?updateMask.fieldPaths=e`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { e: paraFs(limpo) } }) });
}
// chaves dos alertas de preço que ainda existem na conta (ficam guardadas mesmo depois de 15 dias)
// lista e mapa só se forem mesmo (a conta é gravada pelo app: um tipo errado parava a rodada de todo mundo)
const comoLista = (x) => (Array.isArray(x) ? x : []);
const comoMapa = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const alertasDe = (u) => new Set(Object.entries(comoMapa(u.alertas)).flatMap(([tk, als]) => comoLista(als).filter((a) => a.tipo === 'preco').map((a) => `alerta:${tk}:${a.dir}:${a.valor}`)));

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

// os dias que mais mexem com o mercado, de calendario.json (o resto da agenda fica só no app)
const diaImportante = (() => { try { return ler('calendario.json').filter((e) => e.d === hoje && /^(Decisão do Copom|Decisão de juros nos EUA|IPCA de)/.test(e.t)); } catch { return []; } })();

// variação do dia da parte da carteira que está na bolsa, com as cotações desta rodada
function variacaoCarteira(watch, qtd) {
  let agora = 0, antes = 0;
  for (const tk of watch) {
    const q = Number(qtd[tk]);
    const c = cot[tk];
    if (!(q > 0) || !c || !(c[0] > 0) || !Number.isFinite(c[1]) || c[1] <= -100) continue;
    agora += q * c[0];
    antes += (q * c[0]) / (1 + c[1] / 100);
  }
  return antes > 0 ? { pct: (agora / antes - 1) * 100, reais: agora - antes } : null;
}

// ---------- o que cada pessoa deve receber agora ----------
function avisosDe(u, ja, primeira) {
  const n = comoMapa(u.notif);
  const watch = comoLista(u.watch);
  const qtd = comoMapa(u.qtd);
  const lista = [];
  const add = (chave, titulo, texto, dados = {}) => { if (!ja[chave] && !lista.some((x) => x.chave === chave)) lista.push({ chave, titulo, texto, dados }); };

  // alertas de preço: preço alvo vai uma vez; variação vai no máximo uma vez por dia
  if (n.alertas !== false) {
    for (const [tk, als] of Object.entries(comoMapa(u.alertas))) {
      const q = cot[tk];
      if (!q) continue;
      const [preco, v] = q;
      for (const al of comoLista(als)) {
        if (al.tipo === 'preco' && ((al.dir === 'acima' && preco >= al.valor) || (al.dir === 'abaixo' && preco <= al.valor)))
          add(`alerta:${tk}:${al.dir}:${al.valor}`, `${tk} chegou a ${reais(preco)}`, `Seu alerta era ${al.dir === 'acima' ? 'subir até' : 'cair até'} ${reais(al.valor)}.`, { tk });
        // variação só em dia de pregão e depois das 10h15 (antes disso a cotação ainda é a do pregão anterior)
        if (al.tipo === 'var' && pregaoHoje && minutos >= 10 * 60 + 15 && Math.abs(v) >= al.valor)
          add(`var:${tk}:${al.valor}:${hoje}`, `${tk} ${v >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(v)).replace('+', '')} hoje`, `Passou dos ${al.valor.toString().replace('.', ',')}% do seu alerta. Está em ${reais(preco)}.`, { tk });
      }
    }
  }
  // "Todas as notícias" (Perfil): cada notícia nova desde a última rodada vira um aviso. Guarda só até onde já avisou
  // (todas:ate, a hora da notícia mais nova), não uma chave por notícia: são mais de 100 por dia. Na primeira vez, não
  // manda o que já tinha. Ligada, faz o papel das "notícias dos meus ativos" (não repete a mesma notícia)
  const todas = n.todasNoticias === true;
  if (todas) {
    const ate = Number(ja['todas:ate']) || 0;
    const novas = noticias.map((x) => ({ x, t: horaNoticia(x) })).filter((o) => o.t > ate && o.t <= agora.getTime() + 60000).sort((a, b) => a.t - b.t);
    const maior = novas.length ? novas[novas.length - 1].t : ate;
    if (!ate || primeira) ja['todas:ate'] = maior || agora.getTime();
    else if (novas.length) {
      ja['todas:ate'] = maior;
      const soltas = novas.length > TODAS_POR_RODADA ? novas.slice(-(TODAS_POR_RODADA - 1)) : novas;
      if (soltas.length < novas.length) lista.push({ chave: '', todas: true, titulo: `${novas.length - soltas.length} notícias novas`, texto: 'Saíram muitas notícias de uma vez. Toque pra ver todas no app.', dados: { tela: 'hoje' } });
      for (const { x } of soltas) {
        const tk = x.t.find((t) => watch.includes(t)) || x.t[0];
        lista.push({ chave: '', todas: true, titulo: tk ? `${tk} nas notícias` : `Notícia (${x.f})`, texto: tk ? `${x.ti} (${x.f})` : x.ti, dados: /^https:\/\//.test(x.u || '') ? { url: x.u } : { tela: 'hoje' } });
      }
    }
  }
  // principais manchetes do mercado: um aviso por dia, a partir do meio-dia, com as 3 notícias gerais mais novas do dia,
  // de fontes diferentes
  if ((n.manchetes === true || todas) && minutos >= 12 * 60) {
    const fontes = new Set();
    const tres = noticias.filter((x) => x.d === hoje && !x.t.length && !fontes.has(x.f) && fontes.add(x.f)).slice(0, 3);
    if (tres.length >= 2) add(`manchetes:${hoje}`, 'Principais do mercado hoje', tres.map((x) => `• ${x.ti}`).join('\n'), { tela: 'hoje' });
  }
  // notícia nova dos ativos da pessoa (na primeira vez, só da última hora; depois, das últimas 16 horas,
  // pra de manhã pegar o que saiu à noite, quando o robô não roda)
  if (n.noticias !== false && !todas) {
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
        add(chave(x), `${tk} nas notícias`, `${x.ti} (${x.f})`, String(x.u || '').startsWith('https://') ? { tk, url: x.u } : { tk });
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
  // provento ou evento que acabou de aparecer na B3 (aprovado nos últimos 5 dias). A B3 só lista depois da data com,
  // então o aviso é de que saiu: o provento, com o dia de pagamento; o desdobramento, grupamento ou bonificação, com o
  // que mudou. O toque abre o ativo, que mostra a explicação e a quantidade já ajustada.
  if (n.proventos !== false && minutos >= 10 * 60) {
    const cincoDias = new Date(brt.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const semana = new Date(brt.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const num = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
    // a proporção em números pequenos: 1,5 vira "cada 2 viraram 3"
    const prop = (f) => { for (let k = 1; k <= 100; k++) if (Math.abs(k * f - Math.round(k * f)) < 1e-6) return [k, Math.round(k * f)]; return [1, f]; };
    for (const tk of watch) {
      const un = tk.endsWith('11') ? 'cota' : 'ação';
      const uns = un === 'cota' ? 'cotas' : 'ações';
      const q = qtd[tk] > 0 ? qtd[tk] : 0;
      const anunciados = new Map();
      for (const [com, pag, v, , aprov] of fundamentos[tk]?.p || []) {
        if (!aprov || aprov < cincoDias || (pag && pag < hoje)) continue;
        const k = `${com}|${pag}`;
        const x = anunciados.get(k);
        if (x) x.v += v; else anunciados.set(k, { com, pag, v });
      }
      for (const { com, pag, v } of anunciados.values()) {
        add(`anun:${tk}:${com}:${pag}`, `${tk} vai pagar provento`, `${provTxt(v)} por ${un} para quem tinha ${tk} em ${dataCurta(com)}${pag ? `, pago em ${dataCurta(pag)}` : ''}` + (q ? `. Com as suas ${q} ${uns}: ${reais(v * q)}.` : '.'), { tk });
      }
      for (const [com, tipo, f, aprov] of fundamentos[tk]?.e || []) {
        if (!aprov || aprov < cincoDias || com < semana) continue;
        const [de, para] = prop(f);
        const titulo = `${tk} teve ${tipo === 'desd' ? 'desdobramento' : tipo === 'grup' ? 'grupamento' : 'bonificação'}`;
        const texto = tipo === 'bon'
          ? `${num((f - 1) * 100)}% em ${uns} novas para quem tinha ${tk} em ${dataCurta(com)}.`
          : `Cada ${de === 1 ? un : `${de} ${uns}`} ${de === 1 ? 'virou' : 'viraram'} ${num(para)} (data com ${dataCurta(com)}).`;
        add(`ev:${tk}:${com}:${tipo}`, titulo, `${texto} Toque para ver como ficou a sua quantidade e o preço médio.`, { tk });
      }
    }
  }
  // fechamento: rodada das 18h30, só em dia de pregão (a B3 fecha às 17h ou às 18h, conforme o horário de verão
  // dos EUA, e a cotação pode ter até 30 min de atraso)
  // Quem tem quantidade lançada recebe a carteira dele contra o Ibovespa (só a parte da bolsa; a renda fixa quase não
  // muda num dia). Nada disso vai para o log: é dado pessoal.
  if (n.fechamento !== false && minutos >= 18 * 60 + 30 && pregaoHoje && mercado.ibov) {
    const [pts, v] = mercado.ibov;
    const dol = mercado.mundo?.USD || mercado.dolar;
    const porque = temResumo ? ' Toque pra ver o porquê.' : '';
    const dados = { tela: 'hoje', ...(temResumo ? { resumo: '1' } : {}) };
    const cart = variacaoCarteira(watch, qtd);
    if (cart) {
      const r = `${cart.reais >= 0 ? '+' : '-'}${reais(Math.abs(cart.reais))}`;
      add(`fech:${hoje}`, `Fechamento: sua carteira ${cart.pct >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(cart.pct)).replace('+', '')}`, `${r} no dia. O Ibovespa ${v >= 0 ? 'subiu' : 'caiu'} ${pct(Math.abs(v)).replace('+', '')}, aos ${Math.round(pts).toLocaleString('pt-BR')} pontos.${porque}`, dados);
    } else {
      add(`fech:${hoje}`, `Fechamento: Ibovespa ${v >= 0 ? 'sobe' : 'cai'} ${pct(Math.abs(v)).replace('+', '')}`, `Aos ${Math.round(pts).toLocaleString('pt-BR')} pontos.` + (dol ? ` Dólar a ${reais(dol[0])}.` : '') + porque, dados);
    }
  }
  // dia importante para o mercado (decisão do Copom ou do Fed, IPCA): um aviso de manhã, junto com o de fechamento
  if (n.fechamento !== false && minutos >= 10 * 60 && minutos < 13 * 60) {
    for (const e of diaImportante) add(`dia:${e.d}:${e.t}`, `Hoje: ${e.t}`, `${e.s}.`, { tela: 'agenda' });
  }
  // vencimento da renda fixa: na semana do vencimento e no dia (o robô não roda no fim de semana: o "no dia"
  // vale até 3 dias depois, pra quem vence num sábado ou domingo ser avisado na segunda)
  if (n.rendafixa !== false && minutos >= 10 * 60) {
    for (const x of comoLista(u.rf)) {
      if (!x?.venc || !x.id) continue;
      const d = Math.round((new Date(x.venc + 'T12:00:00Z') - new Date(hoje + 'T12:00:00Z')) / 86400000);
      const nome = x.produto === 'Tesouro' ? x.nome : `${x.produto} ${x.nome || ''}`.trim();
      const aplicado = x.valor ? ` Você aplicou ${reais(x.valor)}.` : '';
      if (d >= 1 && d <= 7) add(`rfsem:${x.id}:${x.venc}`, `${nome} vence ${d === 1 ? 'amanhã' : `em ${d} dias`}`, `Vencimento em ${dataCurta(x.venc)}.${aplicado} Veja quanto deve render em Meus ativos.`, { tela: 'ativos' });
      if (d <= 0 && d >= -3) add(`rfdia:${x.id}:${x.venc}`, `${nome} ${d === 0 ? 'vence hoje' : 'venceu'}`, `Vencimento em ${dataCurta(x.venc)}: o dinheiro cai na conta da corretora ou do banco.${aplicado}`, { tela: 'ativos' });
    }
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

// ---------- contas que o administrador mandou apagar (painel do app, coleção apagar) ----------
// Apaga o login e os dados. O pedido fica um dia: o acesso de quem já estava no app ainda vale por até 1 hora e pode
// recriar a conta no banco, então no fim apaga de novo. Conta de administrador nunca. No log, só a contagem (repositório público).
async function apagarContas() {
  const r = await fetch(`${FS}/apagar?pageSize=50`, { headers: H });
  if (!r.ok) { console.log(`apagar contas: não li os pedidos (${r.status})`); return; }
  const pedidos = (await r.json()).documents || [];
  if (!pedidos.length) return;
  const donos = await lerDonos();
  if (!donos.size) { console.log('apagar contas: sem a lista de administradores, não apaguei nada'); return; }
  const dados = (uid) => Promise.all(['usuarios', 'avisos', 'carteiras'].map((c) => fetch(`${FS}/${c}/${uid}`, { method: 'DELETE', headers: H })));
  const tirar = (nome) => fetch(`https://firestore.googleapis.com/v1/${nome}`, { method: 'DELETE', headers: H });
  let apagadas = 0, erros = 0;
  for (const p of pedidos) {
    const uid = p.name.split('/').pop();
    if (donos.has(uid)) { await tirar(p.name); continue; }
    const feito = valor(p.fields?.feitoEm);
    if (feito) {
      if (agora - new Date(feito) > 24 * 3600 * 1000) { await dados(uid); await tirar(p.name); }
      continue;
    }
    const a = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJETO}/accounts:delete`, { method: 'POST', headers: H, body: JSON.stringify({ localId: uid }) });
    const txt = a.ok ? '' : await a.text();
    if (!a.ok && !/USER_NOT_FOUND/.test(txt)) { erros++; console.log(`apagar contas: o Google recusou (${a.status})`); continue; }
    await dados(uid);
    await fetch(`${FS}/apagar/${uid}?updateMask.fieldPaths=feitoEm`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { feitoEm: { timestampValue: agora.toISOString() } } }) });
    apagadas++;
  }
  if (apagadas || erros) console.log(`apagar contas: ${apagadas} apagada(s), ${erros} com erro`);
}

// ---------- roda ----------
await apagarContas().catch((e) => console.log(`apagar contas: ${e.message}`));
// o mesmo celular em duas contas (alguém saiu sem apagar o registro): vale só a conta registrada por último
const existentes = await contas();
const todas = existentes.filter((u) => u.push?.token);

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
    await anotar(u.uid, [{ titulo: recado.titulo, texto: recado.texto, dados }]);
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
  // uma conta com dado estranho não pode parar os avisos dos outros nem a limpeza do fim
  try {
  const antes = await enviados(u.uid);
  const ja = { ...(antes || {}) };
  const ateAntes = ja['todas:ate'];
  const lista = avisosDe(u, ja, antes === null);
  let mudou = antes === null || ja['todas:ate'] !== ateAntes; // "todas as notícias" andou: guarda até onde avisou
  const chegaram = [];
  // os avisos de sempre (até 5) e, para quem ligou "Todas as notícias", as notícias à parte (até 12)
  for (const a of [...lista.filter((x) => !x.todas).slice(0, POR_RODADA), ...lista.filter((x) => x.todas)]) {
    const r = await mandar(u.push.token, a.titulo, a.texto, Object.fromEntries(Object.entries(a.dados).map(([k, v]) => [k, String(v)])));
    if (r === 'sem-endereco') { await tirarEndereco(u.uid); break; }
    if (r !== 'ok') { console.log(`aviso não foi: ${r}`); continue; }
    for (const k of [a.chave, ...(a.marcar || [])].filter(Boolean)) ja[k] = Date.now();
    mandados++;
    mudou = true;
    chegaram.push({ titulo: a.titulo, texto: a.texto, dados: Object.fromEntries(Object.entries(a.dados).map(([k, v]) => [k, String(v)])) });
  }
  if (mudou) await guardar(u.uid, ja, alertasDe(u));
  await anotar(u.uid, chegaram);
  } catch (e) { console.log(`conta ${u.uid.slice(0, 6)}…: pulei (${e.message})`); }
}
console.log(`ok: ${mandados} aviso(s) para ${pessoas} pessoa(s) com notificação ligada`);

// Conta excluída no app (o app apaga usuarios/{uid}): 1x por dia, na primeira rodada, o robô apaga o que sobrou
// dela, como prometido na política de privacidade: o histórico de avisos (avisos/{uid}) e o e-mail e o uid
// nas mensagens de problemas e sugestões (o texto fica, sem ligação com a pessoa).
// (lista de contas vazia é sinal de erro na leitura, nunca de que todo mundo saiu: aí não mexe em nada)
if (minutos < 10 * 60 + 15 && existentes.length) {
  try {
    const vivos = new Set(existentes.map((u) => u.uid));
    let avisosApagados = 0, sugestoesSoltas = 0, pagina = '';
    do {
      const r = await fetch(`${FS}/avisos?pageSize=300&mask.fieldPaths=e${pagina ? `&pageToken=${pagina}` : ''}`, { headers: H });
      if (!r.ok) throw new Error(`Firestore avisos: ${r.status}`);
      const j = await r.json();
      for (const d of j.documents || []) {
        if (vivos.has(d.name.split('/').pop())) continue;
        if ((await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: H })).ok) avisosApagados++;
      }
      pagina = j.nextPageToken || '';
    } while (pagina);
    pagina = '';
    do {
      const r = await fetch(`${FS}/sugestoes?pageSize=300&mask.fieldPaths=uid${pagina ? `&pageToken=${pagina}` : ''}`, { headers: H });
      if (!r.ok) throw new Error(`Firestore sugestoes: ${r.status}`);
      const j = await r.json();
      for (const d of j.documents || []) {
        const uid = d.fields?.uid?.stringValue;
        if (!uid || vivos.has(uid)) continue;
        const tirar = 'updateMask.fieldPaths=uid&updateMask.fieldPaths=email&updateMask.fieldPaths=responder';
        if ((await fetch(`https://firestore.googleapis.com/v1/${d.name}?${tirar}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: {} }) })).ok) sugestoesSoltas++;
      }
      pagina = j.nextPageToken || '';
    } while (pagina);
    console.log(`limpeza de contas excluídas: ${avisosApagados} histórico(s) de aviso apagado(s), ${sugestoesSoltas} sugestão(ões) desligada(s) da pessoa`);
  } catch (e) { console.log(`limpeza de contas excluídas: ${e.message}`); }
}
