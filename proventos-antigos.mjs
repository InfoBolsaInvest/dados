// Proventos antigos (de antes do robô começar a guardar), buscados uma vez só: provento pago não muda mais. Entram
// também os ativos que saíram da bolsa ou mudaram de código desde 2021 (pelos nomes de pregão do pregao.json).
//   ações e units: Fundamentus (desde os anos 90, com o tipo, a data com e o pagamento, sem ajuste de desdobramento)
//   fundos imobiliários e Fiagro: FNET da B3 (aviso de rendimentos oficial de cada fundo, desde o fim de 2016)
// Grava antigos/{TK}.json [[data com, pagamento, valor, tipo], ...] (vai no git). O fundamentos.mjs junta com o
// histórico longo de cada ativo o que for mais antigo que ele.
// Uso (no computador, uma vez; continua de onde parou): node proventos-antigos.mjs [acoes|fiis] [TK...]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const [qual = 'todos', ...so] = process.argv.slice(2);

const cat = (await (await fetch(`${SITE}/catalogo.json?x=${Date.now()}`)).json()).a;
const isin = await (await fetch(`${SITE}/isin.json?x=${Date.now()}`)).json();
mkdirSync('antigos', { recursive: true });
const FEITO = 'antigos/_feito.json';
const feito = existsSync(FEITO) ? JSON.parse(readFileSync(FEITO, 'utf8')) : {};
const hoje = new Date().toISOString().slice(0, 10);

async function pegar(url, opc = {}) {
  for (let t = 1; t <= 4; t++) {
    try {
      const r = await fetch(url, { ...opc, headers: { ...UA, ...(opc.headers || {}) } });
      if (r.ok) return r;
      if (r.status === 404) return null;
    } catch {}
    await espera(2000 * t);
  }
  throw new Error(`falhou: ${url}`);
}
function gravar(tk, lista) {
  const vistos = new Set();
  const l = lista.filter((p) => { const k = p.join('|'); if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((x, y) => (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : x[1] < y[1] ? 1 : -1));
  writeFileSync(`antigos/${tk}.json`, JSON.stringify(l));
  feito[tk] = hoje;
  writeFileSync(FEITO, JSON.stringify(feito));
  return l.length;
}
const iso = (s) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s || '') ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : '');
const num = (s) => Number(String(s || '').replace(/\./g, '').replace(',', '.'));
const celulas = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim()));

// ---------- ações e units: Fundamentus ----------
// colunas: data (com), valor, tipo, data de pagamento, por quantas ações (o valor de 1996 é por lote de 1000)
// o tipo vem escrito de vários jeitos (com e sem acento, e às vezes em UTF-8 lido como latin1): compara sem acento
const TIPO = { 'DIVIDENDO': 'Dividendo', 'DIVIDENDO MENSAL': 'Dividendo', 'JRS CAP PROPRIO': 'JCP', 'JUROS': 'JCP', 'JUROS MENSAL': 'JCP', 'RENDIMENTO': 'Rendimento', 'AMORTIZACAO': 'Amortização', 'REST CAP DIN': 'Restituição de capital', 'RESTITUICAO DE CAPITAL': 'Restituição de capital' };
const tipoDe = (s) => {
  const t = /Ã/.test(s) ? Buffer.from(s, 'latin1').toString('utf8') : s;
  return TIPO[t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim()];
};
async function acao(tk) {
  const r = await pegar(`https://www.fundamentus.com.br/proventos.php?papel=${tk}&tipo=2`);
  if (!r) return 0;
  const html = Buffer.from(await r.arrayBuffer()).toString('latin1');
  const l = [];
  for (const c of celulas(html)) {
    if (c.length < 5) continue;
    const com = iso(c[0]), v = num(c[1]) / (num(c[4]) || 1), tipo = tipoDe(c[2]);
    if (!com || !(v > 0) || !tipo) continue; // subscrição e o que não é dinheiro ficam de fora
    l.push([com, iso(c[3]), Math.round(v * 1e8) / 1e8, tipo]);
  }
  return gravar(tk, l);
}

// ---------- fundos imobiliários e Fiagro: FNET ----------
// o CNPJ de cada fundo pelo ISIN, nos informes mensais da CVM (FII desde 2021 e Fiagro). Também pelas 4 letras do
// ISIN da cota (BRMALLCTF007 é do MALL11): serve para o fundo que saiu da bolsa ou mudou de código
async function cnpjs() {
  const m = {};
  const ler = (url, arq, colCnpj) => {
    execSync(`curl -sf -o .cvm.zip "${url}"`);
    const l = execSync(`unzip -p .cvm.zip ${arq}`, { maxBuffer: 256 * 1024 * 1024 }).toString('latin1').split(/\r?\n/).map((x) => x.split(';'));
    const iC = colCnpj.map((c) => l[0].indexOf(c)).find((i) => i >= 0), iI = l[0].indexOf('Codigo_ISIN');
    for (const x of l.slice(1)) {
      const i = x[iI]?.trim();
      if (!i) continue;
      m[i] = x[iC];
      if (i.slice(6, 9) === 'CTF') m[`letras:${i.slice(2, 6)}`] = x[iC];
    }
  };
  const ano = new Date().getUTCFullYear();
  for (let a = 2021; a <= ano; a++) {
    try { ler(`https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${a}.zip`, `inf_mensal_fii_geral_${a}.csv`, ['CNPJ_Fundo_Classe', 'CNPJ_Fundo']); } catch {}
  }
  for (let k = 1; k <= 4; k++) {
    const d = new Date(Date.UTC(ano, new Date().getUTCMonth() - k, 1));
    const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    try { ler(`https://dados.cvm.gov.br/dados/FIAGRO/DOC/INF_MENSAL/DADOS/inf_mensal_fiagro_${ym}.zip`, `inf_mensal_fiagro_${ym}.csv`, ['CNPJ_Classe']); break; } catch {}
  }
  return m;
}
const FNET = 'https://fnet.bmfbovespa.com.br/fnet/publico';
const tag = (s, t) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() || '';
async function fii(tk, cnpj) {
  // avisos de "Rendimentos e Amortizações" ativos (o retificado fica inativo; o cancelado sai), de qualquer tipo de
  // fundo: desde a regra nova da CVM, o Fiagro publica em outro tipo (11) e os avisos de antes ficam no tipo 1
  const docs = [];
  for (let s = 0; ; s += 200) {
    const r = await pegar(`${FNET}/pesquisarGerenciadorDocumentosDados?d=1&s=${s}&l=200&o[0][dataEntrega]=desc&idCategoriaDocumento=14&idTipoDocumento=41&cnpjFundo=${cnpj}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const j = await r.json();
    docs.push(...(j.data || []).filter((d) => d.status === 'AC'));
    if (!j.data?.length || s + 200 >= j.recordsTotal) break;
  }
  const porData = new Map(); // o mesmo provento em dois avisos: vale o entregue por último
  for (const d of docs) {
    const r = await pegar(`${FNET}/downloadDocumento?id=${d.id}`);
    if (!r) continue;
    const xml = await r.text();
    const entrega = d.dataEntrega.replace(/^(\d\d)\/(\d\d)\/(\d{4})/, '$3-$2-$1');
    // o aviso novo (desde 2022) traz um <Provento> por classe de cota; o antigo, um provento só, com a cota em DadosGerais
    const novos = xml.split('<Provento>').slice(1);
    const blocos = novos.length ? novos.map((p) => [p, tag(p, 'CodNegociacao'), tag(p, 'CodISIN')])
      : [[xml.slice(xml.indexOf('<InformeRendimentos')), tag(xml, 'CodNegociacaoCota'), tag(xml, 'CodISINCota')]];
    // a cota do ativo pelo código ou pelo ISIN; fundo que mudou de código (MALL11 virou PMLL11) traz o código antigo
    // nos avisos de antes: aí vale a cota com o mesmo final (11), e não o recibo (13, 14...)
    const exata = blocos.filter(([, cod, ci]) => cod === tk || ci === isin[tk]);
    const usar = exata.length ? exata : blocos.filter(([, cod]) => !cod || cod.slice(4) === tk.slice(4));
    for (const [p] of usar) {
      for (const [bloco, tipo] of [['Rendimento', 'Rendimento'], ['Amortizacao', 'Amortização']]) {
        const b = p.match(new RegExp(`<${bloco}(?:\\s[^>]*)?>([\\s\\S]*?)</${bloco}>`))?.[1];
        if (!b) continue;
        const com = tag(b, 'DataBase'), pag = tag(b, 'DataPagamento'), v = Number(tag(b, 'ValorProvento') || tag(b, 'ValorProventoCota'));
        if (!/^\d{4}-\d\d-\d\d$/.test(com) || !(v > 0)) continue;
        const k = `${com}|${tipo}`;
        if (!porData.has(k) || porData.get(k).entrega < entrega) porData.set(k, { entrega, p: [com, /^\d{4}-\d\d-\d\d$/.test(pag) ? pag : '', Math.round(v * 1e8) / 1e8, tipo] });
      }
    }
    await espera(150);
  }
  return gravar(tk, [...porData.values()].map((x) => x.p));
}

// os que saíram da bolsa ou mudaram de código desde 2021 (nomes de pregão dos arquivos anuais da B3): quem teve
// recebeu provento enquanto eram negociados. Fundo pelo nome (FII..., FIAGRO...), ação pelo código.
const pregao = await (await fetch(`${SITE}/pregao.json?x=${Date.now()}`)).json();
const nomesDe = {};
for (const [nome, l] of Object.entries(pregao)) for (const t of l) (nomesDe[t] ||= []).push(nome);
const saiu = {};
for (const [tk, nomes] of Object.entries(nomesDe)) {
  if (cat[tk]) continue;
  if (/^[A-Z]{4}11$/.test(tk) && nomes.some((n) => /^(FII|FIAGRO)/.test(n))) saiu[tk] = 'fii';
  else if (/^[A-Z]{4}(3|4|5|6|11)$/.test(tk)) saiu[tk] = 'acao';
}
const tipoAtivo = (tk) => cat[tk]?.[1] || saiu[tk];
const lista = (tipos) => [...Object.keys(cat), ...Object.keys(saiu)].filter((tk) => tipos.includes(tipoAtivo(tk)) && (so.length ? so.includes(tk) : !feito[tk]));
let n = 0, vazios = 0, falhas = [];
async function rodar(tks, fn, paralelo) {
  const fila = [...tks];
  await Promise.all(Array.from({ length: paralelo }, async () => {
    while (fila.length) {
      const tk = fila.shift();
      try { const q = await fn(tk); n++; if (!q) vazios++; if (n % 20 === 0) console.log(`${n} ativos (${fila.length} na fila)`); }
      catch (e) { falhas.push(tk); console.log(tk, e.message); }
      await espera(300);
    }
  }));
}
if (qual === 'todos' || qual === 'acoes') await rodar(lista(['acao']), acao, 3);
if (qual === 'todos' || qual === 'fiis') {
  const porIsin = await cnpjs();
  const tks = lista(['fii', 'fiagro']);
  // fundo sem ISIN no informe da CVM (ou com o ISIN de antes de mudar de código): o CNPJ da página dele no Investidor10
  const cnpj = Object.fromEntries(tks.map((tk) => [tk, porIsin[isin[tk]] || porIsin[`letras:${tk.slice(0, 4)}`]]));
  for (const tk of tks.filter((t) => !cnpj[t])) {
    try {
      const html = await (await pegar(`https://investidor10.com.br/fiis/${tk.toLowerCase()}/`))?.text();
      cnpj[tk] = html?.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)?.[0];
    } catch {}
    await espera(500);
  }
  const sem = tks.filter((tk) => !cnpj[tk]);
  if (sem.length) console.log(`sem CNPJ (${sem.length}): ${sem.join(', ')}`);
  await rodar(tks.filter((tk) => cnpj[tk]), (tk) => fii(tk, cnpj[tk]), 3);
}
console.log(`ok: ${n} ativos, ${vazios} sem provento, ${falhas.length} falharam${falhas.length ? ': ' + falhas.join(', ') : ''}`);
