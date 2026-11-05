// Proventos e valor patrimonial (uma vez por dia, na primeira rodada do dia), tudo de fonte grátis:
//   proventos: B3 (dados oficiais de cada empresa e fundo: valor, data com e data de pagamento)
//   valor patrimonial por cota dos fundos imobiliários: informe mensal da CVM (dados abertos)
//   valor patrimonial por ação: Yahoo Finanças (não oficial)
// Gera site/fundamentos.json { atualizadoEm, a: { TICKER: { p: [[data com, pagamento, valor, tipo, aprovado em], ...], vp, e } } }
// (e: desdobramento, grupamento e bonificação, ver guardarEv)
// Precisa do .isin.json do b3.mjs e do site/catalogo.json do atualizar.mjs.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const agora = new Date();

// o que já está publicado: base pra quando alguma fonte falhar, e pra não refazer no mesmo dia
let anterior = { atualizadoEm: '', a: {} };
try {
  const r = await fetch(`${SITE}/fundamentos.json?x=${Date.now()}`);
  if (r.ok) anterior = await r.json();
} catch {}
if (anterior.atualizadoEm && diaBR(new Date(anterior.atualizadoEm)) === diaBR(agora) && process.env.FUNDAMENTOS !== '1') {
  writeFileSync('site/fundamentos.json', JSON.stringify(anterior));
  console.log('ok: fundamentos de hoje já feitos');
  process.exit(0);
}

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const isinHoje = existsSync('.isin.json') ? JSON.parse(readFileSync('.isin.json', 'utf8')) : {};
let isinAntes = {};
try { const r = await fetch(`${SITE}/isin.json?x=${Date.now()}`); if (r.ok) isinAntes = await r.json(); } catch {}
const isin = { ...isinAntes, ...isinHoje }; // quem não negociou hoje usa o ISIN de outro dia
writeFileSync('site/isin.json', JSON.stringify(isin));
const tickerDoIsin = Object.fromEntries(Object.entries(isin).filter(([tk]) => cat[tk]).map(([tk, i]) => [i, tk]));

// ---------- proventos (B3) ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const B3 = 'https://sistemaswebb3-listados.b3.com.br';
async function b3(url) {
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await espera(1500 * t);
  }
  return null;
}
const data = (s) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s || '') ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : '');
const valor = (s) => Number(String(s || '0').replace(/\./g, '').replace(',', '.'));
const TIPO = { 'DIVIDENDO': 'Dividendo', 'JRS CAP PROPRIO': 'JCP', 'RENDIMENTO': 'Rendimento', 'AMORTIZACAO': 'Amortização', 'AMORTIZAÇÃO': 'Amortização', 'REST CAP DIN': 'Restituição de capital' };
const limite = diaBR(new Date(agora.getTime() - 400 * 86400 * 1000)); // guarda pouco mais de 1 ano (o DY usa 12 meses)

const empresas = new Set();
const fundos = new Set();
for (const [tk, [, tipo]] of Object.entries(cat)) {
  if (tipo === 'acao' || tipo === 'bdr') empresas.add(tk.slice(0, 4));
  else if (tipo === 'fii' || tipo === 'fiagro' || tipo === 'fundo') fundos.add(tk.slice(0, 4));
}
const prov = {};
const todos = {}; // tudo o que a B3 mostra hoje (site/proventos/{TK}.json, para o gráfico de 5 anos e o IR)
let consultas = 0, falhas = 0;
const falhouB3 = new Set(); // prefixos (PETR, MXRF...) cuja consulta de proventos falhou hoje
function guardar(lista) {
  for (const d of lista || []) {
    const tk = tickerDoIsin[d.isinCode];
    const com = data(d.lastDatePrior), pag = data(d.paymentDate), v = valor(d.rate);
    if (!tk || !com || !(v > 0)) continue;
    const tipo = TIPO[(d.label || '').toUpperCase()] || (d.label || '').trim();
    (todos[tk] ||= []).push([com, data(d.paymentDate), Math.round(v * 1e8) / 1e8, tipo]);
    if (com < limite) continue;
    (prov[tk] ||= []).push([com, pag, Math.round(v * 1e8) / 1e8, tipo, data(d.approvedOn)]); // o 5º campo (aprovado em) é para o aviso de anúncio
  }
}
// desdobramento, grupamento e bonificação: [data com, tipo, multiplicador da quantidade, aprovado em]. Guarda tudo
// (são poucos), porque a pessoa pode ter comprado anos atrás. No desdobramento e na bonificação a B3 dá o % de
// ações novas (300 = cada ação vira 4); no grupamento, a proporção (0,1 = 10 viram 1).
const EVENTO = { DESDOBRAMENTO: 'desd', GRUPAMENTO: 'grup', BONIFICACAO: 'bon' };
const ev = {};
const codigoCvm = {}; // prefixo da empresa -> código na CVM (o eventos.mjs acha o aviso da bonificação por ele)
// ISIN que mudou (a ON da Azul ganhou um novo na reestruturação, e o arquivo da B3 ainda liga a AZUL3 ao antigo): pela
// classe escrita no ISIN (OR = ON, PR = PN, PA, PB), a ação dessa classe da empresa
const CLASSE_ISIN = { OR: '3', PR: '4', PA: '5', PB: '6' };
const pelaClasse = (i, prefixo) => { const n = CLASSE_ISIN[String(i || '').slice(9, 11)]; return n && prefixo && cat[prefixo + n] && String(i).slice(2, 6) === prefixo ? prefixo + n : undefined; };
function guardarEv(lista, prefixo) {
  for (const d of lista || []) {
    const tipo = EVENTO[(d.label || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()];
    const tk = tickerDoIsin[d.isinCode] || tickerDoIsin[d.assetIssued] || pelaClasse(d.isinCode, prefixo);
    const com = data(d.lastDatePrior), f = valor(d.factor);
    if (!tipo || !tk || !com || !(f > 0)) continue;
    const mult = tipo === 'grup' ? f : 1 + f / 100;
    if (tipo === 'grup' ? mult >= 1 : mult <= 1) continue; // proporção estranha: melhor não aplicar
    (ev[tk] ||= []).push([com, tipo, Number(mult.toPrecision(10)), data(d.approvedOn)]);
  }
}
const fila = [
  ...[...empresas].map((c) => ({ prefixo: c, url: `${B3}/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/${b64({ issuingCompany: c, language: 'pt-br' })}` })),
  ...[...fundos].map((c) => ({ prefixo: c, url: `${B3}/fundsProxy/fundsCall/GetListedSupplementFunds/${b64({ cnpj: '0', identifierFund: c, typeFund: 7 })}` })),
];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (fila.length) {
    const { url, prefixo } = fila.shift();
    const j = await b3(url);
    consultas++;
    if (!j) { falhas++; falhouB3.add(prefixo); continue; }
    guardar(Array.isArray(j) ? j[0]?.cashDividends : j.cashDividends);
    guardarEv(Array.isArray(j) ? j[0]?.stockDividends : j.stockDividends, url.includes('CompanyCall') ? prefixo : '');
    const cvm = (Array.isArray(j) ? j[0] : j)?.codeCVM;
    if (cvm && url.includes('CompanyCall')) codigoCvm[prefixo] = String(cvm);
    await espera(100);
  }
}));
for (const tk of Object.keys(prov)) {
  // a mesma linha pode vir repetida (empresa com mais de uma classe); mais recente primeiro
  const vistos = new Set();
  prov[tk] = prov[tk].filter((p) => { const k = p.join('|'); if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((x, y) => (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : x[1] < y[1] ? 1 : -1));
}
for (const tk of Object.keys(ev)) {
  const vistos = new Set();
  ev[tk] = ev[tk].filter((e) => { const k = `${e[0]}|${e[1]}`; if (vistos.has(k)) return false; vistos.add(k); return true; }).sort((x, y) => (x[0] < y[0] ? 1 : -1));
}
console.log(`proventos: ${consultas} consultas na B3, ${falhas} falharam, ${Object.keys(prov).length} ativos com provento, ${Object.keys(ev).length} com desdobramento, grupamento ou bonificação`);
if (consultas && falhas / consultas > 0.3) throw new Error(`a B3 falhou em ${falhas} de ${consultas} consultas de proventos`);

// ---------- valor patrimonial dos fundos imobiliários (CVM) ----------
const vp = {};
async function cvm(ano) {
  const r = await fetch(`https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${ano}.zip`);
  if (!r.ok) return false;
  writeFileSync('.cvm.zip', Buffer.from(await r.arrayBuffer()));
  const ler = (arq) => execSync(`unzip -p .cvm.zip ${arq}`, { maxBuffer: 256 * 1024 * 1024 }).toString('latin1').split(/\r?\n/).map((l) => l.split(';'));
  const geral = ler(`inf_mensal_fii_geral_${ano}.csv`);
  const comp = ler(`inf_mensal_fii_complemento_${ano}.csv`);
  const g = geral[0], c = comp[0];
  const iCnpjG = g.indexOf('CNPJ_Fundo_Classe'), iIsin = g.indexOf('Codigo_ISIN');
  const iCnpjC = c.indexOf('CNPJ_Fundo_Classe'), iData = c.indexOf('Data_Referencia'), iVp = c.indexOf('Valor_Patrimonial_Cotas');
  const cnpjIsin = {};
  for (const l of geral.slice(1)) if (l[iIsin]) cnpjIsin[l[iCnpjG]] = l[iIsin].trim();
  const ultimo = {};
  for (const l of comp.slice(1)) {
    const v = Number(l[iVp]);
    if (!(v > 0) || (ultimo[l[iCnpjC]] && ultimo[l[iCnpjC]][0] >= l[iData])) continue;
    ultimo[l[iCnpjC]] = [l[iData], v];
  }
  for (const [cnpj, [, v]] of Object.entries(ultimo)) {
    const tk = tickerDoIsin[cnpjIsin[cnpj]];
    if (tk && !vp[tk]) vp[tk] = Math.round(v * 100) / 100;
  }
  return true;
}
try {
  const ano = agora.getUTCFullYear();
  await cvm(ano);
  if (agora.getUTCMonth() < 3) await cvm(ano - 1); // começo do ano: o informe novo ainda tem poucos fundos
  console.log(`valor patrimonial (CVM): ${Object.keys(vp).length} fundos imobiliários`);
} catch (e) { console.log(`CVM: ${e.message}`); }

// Fiagro: um arquivo por mês, com ISIN e valor da cota na mesma linha; usa o mês mais recente publicado
try {
  let n = 0;
  for (let m = 1; m <= 4 && !n; m++) {
    const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - m, 1));
    const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const r = await fetch(`https://dados.cvm.gov.br/dados/FIAGRO/DOC/INF_MENSAL/DADOS/inf_mensal_fiagro_${ym}.zip`);
    if (!r.ok) continue;
    writeFileSync('.cvm.zip', Buffer.from(await r.arrayBuffer()));
    const linhas = execSync(`unzip -p .cvm.zip inf_mensal_fiagro_${ym}.csv`, { maxBuffer: 64 * 1024 * 1024 }).toString('latin1').split(/\r?\n/).map((l) => l.split(';'));
    const iIsin = linhas[0].indexOf('Codigo_ISIN'), iVp = linhas[0].indexOf('Valor_Patrimonial_Cotas');
    for (const l of linhas.slice(1)) {
      const tk = tickerDoIsin[(l[iIsin] || '').trim()], v = Number(l[iVp]);
      if (tk && v > 0 && !vp[tk]) { vp[tk] = Math.round(v * 100) / 100; n++; }
    }
  }
  console.log(`valor patrimonial (CVM): ${n} Fiagros`);
} catch (e) { console.log(`CVM Fiagro: ${e.message}`); }

// ---------- valor patrimonial por ação (Yahoo) ----------
try {
  const r0 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' });
  const cookie = (r0.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': 'Mozilla/5.0', cookie } })).text();
  const acoes = Object.keys(cat).filter((tk) => cat[tk][1] === 'acao');
  let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (acoes.length) {
      const tk = acoes.shift();
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${tk}.SA?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`, { headers: { 'User-Agent': 'Mozilla/5.0', cookie } });
        if (r.ok) {
          const k = (await r.json())?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
          const bv = k?.bookValue?.raw, pb = k?.priceToBook?.raw;
          // só aceita quando o P/VP do próprio Yahoo bate com o valor patrimonial (evita unidade trocada)
          if (bv > 0 && pb > 0.05 && pb < 50) { vp[tk] = Math.round(bv * 100) / 100; n++; }
        }
      } catch {}
      await espera(120);
    }
  }));
  // empresa com unit (SAPR11, ENGI11, KLBN11, SANB11...): o Yahoo dá o valor da unit também pras ações ON e PN,
  // o que deixa o P/VP delas errado. Fica só na unit.
  for (const tk of Object.keys(vp)) {
    const unit = `${tk.slice(0, 4)}11`;
    if (tk !== unit && cat[tk][1] === 'acao' && cat[unit]?.[1] === 'acao') { delete vp[tk]; n--; }
  }
  console.log(`valor patrimonial (Yahoo): ${n} ações`);
} catch (e) { console.log(`Yahoo: ${e.message}`); }

// ---------- eventos antigos (Yahoo) ----------
// A B3 só mostra o último evento de cada empresa (da ITSA4, só a bonificação de 2025; as de 2022 e 2023 sumiram), e
// quem manda notas de anos atrás precisa dos antigos. O Yahoo tem a lista inteira desde 2020 (bonificação e
// desdobramento vêm juntos, como "11:10"). Cada ativo é olhado uma vez e de novo depois de 60 dias, 400 por dia, os
// mais negociados primeiro. Guardado em site/proventos (cache do Actions; sem ele, vale o publicado).
const ARQ_Y = 'site/proventos/_eventos-yahoo.json';
mkdirSync('site/proventos', { recursive: true });
let evY = {};
if (existsSync(ARQ_Y)) evY = JSON.parse(readFileSync(ARQ_Y, 'utf8'));
else try { const r = await fetch(`${SITE}/proventos/_eventos-yahoo.json`); if (r.ok) evY = await r.json(); } catch {}
const diaUtilAntes = (iso) => { const d = new Date(`${iso}T12:00:00Z`); do d.setUTCDate(d.getUTCDate() - 1); while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); };
const velho = diaBR(new Date(agora.getTime() - 60 * 86400000));
const filaY = Object.keys(cat).filter((tk) => !evY[tk] || evY[tk].d < velho)
  .sort((x, y) => (!evY[x] !== !evY[y] ? (evY[x] ? 1 : -1) : (cat[y][4] || 0) - (cat[x][4] || 0))).slice(0, 400);
let olhadosY = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (filaY.length) {
    const tk = filaY.shift();
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${tk}.SA?period1=946684800&period2=${Math.floor(Date.now() / 1000)}&interval=1mo&events=split`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status !== 200 && r.status !== 404) continue; // limite ou falha: tenta outro dia
      const s = r.ok ? (await r.json()).chart?.result?.[0]?.events?.splits || {} : {};
      const e = [];
      for (const x of Object.values(s)) {
        const mult = x.numerator / x.denominator;
        if (!(mult > 0) || Math.abs(mult - 1) < 0.001) continue;
        // a data do Yahoo é a data ex; a data com é o pregão anterior
        const com = diaUtilAntes(diaBR(new Date(x.date * 1000)));
        e.push([com, mult < 1 ? 'grup' : mult <= 1.35 ? 'bon' : 'desd', Number(mult.toPrecision(10))]);
      }
      evY[tk] = { d: diaBR(agora), e };
      olhadosY++;
    } catch {}
    await espera(150);
  }
}));
writeFileSync(ARQ_Y, JSON.stringify(evY));
console.log(`eventos antigos (Yahoo): ${olhadosY} ativos olhados hoje, ${Object.keys(evY).length} no total`);
// o mesmo evento em duas fontes: datas a até 10 dias e a mesma proporção (a B3 dá a data com; o Yahoo, a ex)
const mesmoEv = (x, y) => Math.abs(new Date(x[0]) - new Date(y[0])) <= 10 * 86400000 && Math.abs(x[2] / y[2] - 1) < 0.02;

// ---------- junta e publica ----------
const a = {};
for (const tk of new Set([...Object.keys(prov), ...Object.keys(vp), ...Object.keys(ev), ...Object.keys(evY).filter((t) => evY[t].e.length)])) {
  a[tk] = {};
  if (prov[tk]) a[tk].p = prov[tk];
  if (vp[tk]) a[tk].vp = vp[tk];
  // os eventos da B3 de hoje, os que ela já mostrou antes e parou de mostrar, e os do Yahoo que nenhuma das duas tem
  const antes = anterior.a?.[tk]?.e || [];
  // o custo atribuído da bonificação (5º campo) vem do eventos.mjs: fica o que já foi achado antes
  const e = (ev[tk] || []).map((e) => { const x = antes.find((y) => y[0] === e[0] && y[1] === e[1]); return x && x.length > 4 ? [...e, x[4]] : e; });
  for (const x of antes) if (!e.some((y) => (y[0] === x[0] && y[1] === x[1]) || mesmoEv(x, y))) e.push(x);
  for (const x of evY[tk]?.e || []) if (!e.some((y) => mesmoEv(x, y))) e.push(x);
  if (e.length) a[tk].e = e.sort((x, y) => (x[0] < y[0] ? 1 : -1));
}
// o que falhou hoje fica com o dado de ontem: o ativo inteiro, ou só a parte que faltou
// (proventos de quem a consulta na B3 falhou; valor patrimonial quando a CVM ou o Yahoo não responderam)
for (const [tk, x] of Object.entries(anterior.a || {})) {
  if (!cat[tk]) continue;
  if (!a[tk]) { a[tk] = x; continue; }
  if (!a[tk].p && x.p && falhouB3.has(tk.slice(0, 4))) a[tk].p = x.p;
  if (!a[tk].e && x.e && falhouB3.has(tk.slice(0, 4))) a[tk].e = x.e;
  if (!a[tk].vp && x.vp) a[tk].vp = x.vp;
}
writeFileSync('site/fundamentos.json', JSON.stringify({ atualizadoEm: agora.toISOString(), a }));
writeFileSync('.cvm-codigos.json', JSON.stringify(codigoCvm));
// histórico longo de proventos, um arquivo por ativo. A B3 só mostra uns 12 meses: o robô junta com o que já
// tinha guardado (cache do Actions, junto com o histórico de preços) e o histórico cresce com o tempo. Quem falhou
// hoje continua com o arquivo de antes.
// Sem o arquivo aqui (o cache do Actions sumiu), vale o publicado: o histórico não volta a ter só 12 meses.
mkdirSync('site/proventos', { recursive: true });
let longos = 0;
const publicado = async (tk) => { try { const r = await fetch(`${SITE}/proventos/${tk}.json`); return r.ok ? await r.json() : []; } catch { return []; } };
const tksLongos = Object.keys(todos).filter((tk) => cat[tk]);
const deFora = {};
const faltam = tksLongos.filter((tk) => !existsSync(`site/proventos/${tk}.json`));
for (let i = 0; i < faltam.length; i += 10) await Promise.all(faltam.slice(i, i + 10).map(async (tk) => { deFora[tk] = await publicado(tk); }));
if (faltam.length) console.log(`proventos longos: ${faltam.length} vieram do site publicado`);
for (const [tk, lista] of Object.entries(todos)) {
  if (!cat[tk]) continue;
  const arq = `site/proventos/${tk}.json`;
  // dentro do período que a B3 mostra hoje vale só a lista dela (provento que mudou de data ou valor não fica duas vezes)
  const desde = lista.map((p) => p[0]).sort()[0];
  const antes = (existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : deFora[tk] || []).filter((p) => !desde || p[0] < desde);
  const vistos = new Set();
  // o mesmo provento: mesma data com, pagamento, tipo e valor (a empresa pode pagar dois JCP no mesmo dia)
  const l = [...lista, ...antes].filter((p) => { const k = `${p[0]}|${p[1]}|${p[3]}|${p[2]}`; if (vistos.has(k)) return false; vistos.add(k); return true; }).sort((x, y) => (x[0] < y[0] ? 1 : -1));
  writeFileSync(arq, JSON.stringify(l));
  longos++;
}
// proventos antigos (antigos/{TK}.json, do proventos-antigos.mjs, guardados no git): entra o que for mais antigo que
// o histórico longo do ativo. O mesmo provento com 1 ou 2 dias de diferença entre as fontes (ou o valor arredondado
// do Fundamentus) não entra duas vezes. Ativo sem provento nos últimos 12 meses (não está na lista da B3) fica só
// com os antigos, e o que saiu da bolsa também (MALL11): quem teve recebeu enquanto era negociado.
const diasEntre = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
let comAntigos = 0;
for (const f of existsSync('antigos') ? readdirSync('antigos').filter((x) => /^[A-Z0-9]+\.json$/.test(x)) : []) {
  const tk = f.slice(0, -5);
  const arq = `site/proventos/${tk}.json`;
  const atual = existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : [];
  const desde = atual.map((p) => p[0]).sort()[0];
  const igual = (p) => atual.some((a) => a[3] === p[3] && diasEntre(a[0], p[0]) <= 5 && Math.abs(a[2] / p[2] - 1) < 0.01);
  const velhos = JSON.parse(readFileSync(`antigos/${f}`, 'utf8')).filter((p) => (!desde || p[0] < desde) && !igual(p));
  if (!velhos.length) continue;
  writeFileSync(arq, JSON.stringify([...atual, ...velhos].sort((x, y) => (x[0] < y[0] ? 1 : -1))));
  comAntigos++;
}
writeFileSync('.historico-novo', '1');
console.log(`proventos longos: ${longos} ativos (${comAntigos} com os antigos)`);
console.log(`ok: fundamentos de ${Object.keys(a).length} ativos`);
