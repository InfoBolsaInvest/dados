// CNPJ e nome de quem emite cada ativo, para a aba IR do app: o programa da Receita pede o CNPJ em cada bem e em cada
// provento. Uma vez por semana (muda pouco), tudo de dado aberto:
//   ações, units e BDR: cadastro anual das companhias na CVM (FCA, desde 2010), que liga o código de negociação ao CNPJ,
//     também de quem já saiu da bolsa; o que faltar, pela lista de empresas da B3 (pelas 4 letras do código)
//   FII: informe mensal da CVM (ISIN e CNPJ do fundo, desde 2016); Fiagro: informe mensal do Fiagro
//   ETF e o que sobrar dos fundos: lista de fundos da B3 (sigla e nome) com o cadastro de fundos da CVM (nome e CNPJ)
// Gera site/cnpj.json { atualizadoEm, a: { TICKER: [CNPJ só com números, nome, (fundo) CNPJ do administrador, nome
// dele] }, cor: { CNPJ: nome da corretora } }. Quem já estava publicado não sai.
// Precisa do site/catalogo.json do atualizar.mjs.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const agora = new Date();
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

let anterior = { atualizadoEm: '', a: {} };
try {
  const r = await fetch(`${SITE}/cnpj.json?x=${Date.now()}`);
  if (r.ok) anterior = await r.json();
} catch {}
if (anterior.atualizadoEm && anterior.cor && agora - new Date(anterior.atualizadoEm) < 7 * 86400000 && process.env.CNPJ !== '1') {
  writeFileSync('site/cnpj.json', JSON.stringify(anterior));
  console.log('ok: CNPJs da semana já feitos');
  process.exit(0);
}

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
let pregao = {};
try { const r = await fetch(`${SITE}/pregao.json?x=${Date.now()}`); if (r.ok) pregao = await r.json(); } catch {}
const quer = new Set([...Object.keys(cat), ...Object.values(pregao).flat()]);
let isin = {};
try { const r = await fetch(`${SITE}/isin.json?x=${Date.now()}`); if (r.ok) isin = await r.json(); } catch {}
const tickerDoIsin = Object.fromEntries(Object.entries(isin).map(([tk, i]) => [i, tk]));

const so = (c) => String(c || '').replace(/\D/g, '').padStart(14, '0');
const limpo = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const chave = (s) => limpo(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const a = {};
const por = {}; // de onde veio, só para o resumo
const pôr = (tk, cnpj, nome, fonte) => {
  if (!quer.has(tk) || a[tk] || !/^\d{14}$/.test(so(cnpj)) || /^0+$/.test(so(cnpj))) return;
  a[tk] = [so(cnpj), limpo(nome)];
  por[fonte] = (por[fonte] || 0) + 1;
};
function csv(url, arq) { // url vazia: outro arquivo do zip já baixado
  if (url) execSync(`curl -sf -o .cnpj.zip "${url}"`);
  const l = execSync(`unzip -p .cnpj.zip ${arq}`, { maxBuffer: 512 * 1024 * 1024 }).toString('latin1').split(/\r?\n/).map((x) => x.split(';'));
  const col = (...n) => n.map((c) => l[0].indexOf(c)).find((i) => i >= 0);
  return { linhas: l.slice(1).filter((x) => x.length > 1), col };
}
const ano = agora.getUTCFullYear();

// ---------- companhias (CVM, do mais novo para o mais velho: vale o cadastro mais recente) ----------
for (let y = ano; y >= 2010; y--) {
  try {
    const { linhas, col } = csv(`https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FCA/DADOS/fca_cia_aberta_${y}.zip`, `fca_cia_aberta_valor_mobiliario_${y}.csv`);
    const iC = col('CNPJ_Companhia'), iN = col('Nome_Empresarial'), iT = col('Codigo_Negociacao');
    for (const x of linhas) pôr(limpo(x[iT]).toUpperCase(), x[iC], x[iN], 'CVM (companhias)');
  } catch {}
}
// a mesma empresa com outro código (ação nova, recibo): pelas 4 letras, quando todos os códigos dela têm o mesmo CNPJ
const prefixo = {};
for (const [tk, v] of Object.entries(a)) { const p = tk.slice(0, 4); (prefixo[p] ||= new Map()).set(v[0], v); }
// lista de empresas da B3 (também os BDRs)
try {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  for (let p = 1, total = 1; p <= total; p++) {
    let j = null;
    for (let t = 1; t <= 3 && !j; t++) {
      try {
        const r = await fetch(`https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetInitialCompanies/${b64({ language: 'pt-br', pageNumber: p, pageSize: 120 })}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) j = await r.json();
      } catch {}
      if (!j) await espera(1500 * t);
    }
    if (!j) break;
    total = j.page?.totalPages || 0;
    for (const e of j.results || []) if (e.issuingCompany && e.cnpj) (prefixo[e.issuingCompany] ||= new Map()).set(so(e.cnpj), [so(e.cnpj), e.companyName]);
    await espera(150);
  }
} catch (e) { console.log(`B3 (empresas): ${e.message}`); }
for (const tk of quer) {
  const m = prefixo[tk.slice(0, 4)];
  const tipo = cat[tk]?.[1];
  const fundo = ['fii', 'fiagro', 'etf', 'fundo'].includes(tipo) || (!tipo && tk.slice(4) === '11'); // fundo tem as mesmas 4 letras de alguma empresa às vezes
  if (!a[tk] && !fundo && m?.size === 1) { const [v] = m.values(); pôr(tk, v[0], v[1], 'pelas 4 letras'); }
}

// ---------- fundos imobiliários e Fiagro (CVM, pelo ISIN) ----------
// o ISIN da cota (BRMXRFCTF008) tem as 4 letras do código: serve também para o fundo que saiu da bolsa
const peloIsin = (i) => tickerDoIsin[i] || (i.slice(6, 9) === 'CTF' ? `${i.slice(2, 6)}11` : '');
for (let y = ano; y >= 2016; y--) {
  try {
    const { linhas, col } = csv(`https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${y}.zip`, `inf_mensal_fii_geral_${y}.csv`);
    const iC = col('CNPJ_Fundo_Classe', 'CNPJ_Fundo'), iN = col('Nome_Fundo_Classe', 'Nome_Fundo'), iI = col('Codigo_ISIN');
    // do mais recente para o mais antigo dentro do ano
    const iD = col('Data_Referencia');
    for (const x of linhas.sort((p, q) => (p[iD] < q[iD] ? 1 : -1))) { const i = limpo(x[iI]); if (i) pôr(peloIsin(i), x[iC], x[iN], 'CVM (FII)'); }
  } catch {}
}
for (let k = 1, achou = 0; k <= 4 && !achou; k++) {
  const d = new Date(Date.UTC(ano, agora.getUTCMonth() - k, 1));
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    const { linhas, col } = csv(`https://dados.cvm.gov.br/dados/FIAGRO/DOC/INF_MENSAL/DADOS/inf_mensal_fiagro_${ym}.zip`, `inf_mensal_fiagro_${ym}.csv`);
    const iC = col('CNPJ_Classe', 'CNPJ_Fundo_Classe', 'CNPJ_Fundo'), iN = col('Denominacao_Social_Classe', 'Nome_Classe', 'Denominacao_Social', 'Nome_Fundo_Classe', 'Nome_Fundo'), iI = col('Codigo_ISIN');
    for (const x of linhas) { const i = limpo(x[iI]); if (i) pôr(peloIsin(i), x[iC], x[iN], 'CVM (Fiagro)'); }
    achou = 1;
  } catch {}
}

// ---------- ETF e os fundos que faltaram (lista da B3 pelo nome, no cadastro de fundos da CVM) ----------
const adm = {}; // CNPJ do fundo -> [CNPJ do administrador, nome]
try {
  const { linhas, col } = csv('https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip', 'registro_classe.csv');
  const iC = col('CNPJ_Classe'), iN = col('Denominacao_Social'), iS = col('Situacao');
  // administrador de cada fundo (o cadastro da classe aponta o fundo pelo ID; o do fundo traz o administrador)
  const fundos = csv('', 'registro_fundo.csv');
  const fId = fundos.col('ID_Registro_Fundo'), fC = fundos.col('CNPJ_Fundo'), fA = fundos.col('CNPJ_Administrador'), fN = fundos.col('Administrador'), fS = fundos.col('Situacao');
  const doId = {};
  for (const x of fundos.linhas) {
    if (!/^\d{14}$/.test(so(x[fA])) || /^0+$/.test(so(x[fA]))) continue;
    const v = [so(x[fA]), limpo(x[fN])];
    doId[x[fId]] = v;
    if (!adm[so(x[fC])] || !/Cancel/i.test(x[fS])) adm[so(x[fC])] = v;
  }
  const cId = col('ID_Registro_Fundo');
  for (const x of linhas) if (doId[x[cId]] && (!adm[so(x[iC])] || !/Cancel/i.test(x[iS]))) adm[so(x[iC])] = doId[x[cId]];
  const doNome = new Map();
  for (const x of linhas) { const k = chave(x[iN]); if (k && (!doNome.has(k) || !/Cancel/i.test(x[iS]))) doNome.set(k, [x[iC], x[iN]]); }
  // a B3 abrevia muitos nomes ("FDO INV COTAS FDO INV INFRA RF CP"): sem o nome igual, pelas palavras que distinguem o
  // fundo, quando um só fundo da CVM tem todas (ou quase todas) elas
  const COMUNS = new Set('FUNDO FUNDOS FDO DE DO DA DOS DAS EM E INVESTIMENTO INVESTIMENTOS INV FI FIC COTAS COTA CLASSE CLASSES RESPONSABILIDADE RESP LIMITADA LTDA RL RF CP CRED CREDITO PRIVADO RENDA FIXA INFRA INFRAESTRUTURA INCENTIVADO INCENTIVADA FIF FIIF FI-INFRA FIP IE ETF INDICE'.split(' '));
  const palavras = (s) => new Set(limpo(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 2 && !COMUNS.has(w)));
  const cvmPal = linhas.filter((x) => !/Cancel/i.test(x[iS])).map((x) => ({ p: palavras(x[iN]), v: [x[iC], x[iN]] }));
  const parecido = (nome) => {
    const b = palavras(nome);
    if (b.size < 2) return null;
    const notas = cvmPal.map((c) => ({ n: [...b].filter((w) => c.p.has(w)).length / b.size, v: c.v })).filter((c) => c.n >= 0.75).sort((x, y) => y.n - x.n);
    return notas.length && (notas.length === 1 || notas[1].n < notas[0].n) ? notas[0].v : null;
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  for (const tipo of ['ETF', 'ETF-RF', 'FI-INFRA', 'FIP', 'FIDC', 'FII', 'FIAGRO']) {
    for (let p = 1, total = 1; p <= total; p++) {
      const r = await fetch(`https://sistemaswebb3-listados.b3.com.br/fundsListedProxy/Search/GetListFunds/${b64({ language: 'pt-br', typeFund: tipo, pageNumber: p, pageSize: 120 })}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) break;
      const j = await r.json();
      total = j.page?.totalPages || 0;
      for (const f of j.results || []) {
        if (!f.acronym) continue;
        const tks = [...quer].filter((tk) => tk.slice(0, 4) === f.acronym && /^1[1-9]$|^3[2-9]$/.test(tk.slice(4)) && !a[tk]);
        if (!tks.length) continue;
        const igual = doNome.get(chave(f.fundName));
        const v = igual || parecido(f.fundName);
        if (v) for (const tk of tks) pôr(tk, v[0], v[1], `B3 e CVM (${tipo}${igual ? '' : ', nome parecido'})`);
      }
      await espera(150);
    }
  }
} catch (e) { console.log(`ETF: ${e.message}`); }

// o administrador vai junto do fundo: [CNPJ, nome, CNPJ do administrador, nome do administrador]
let comAdm = 0;
for (const v of Object.values(a)) if (adm[v[0]] && adm[v[0]][0] !== v[0]) { v.push(...adm[v[0]]); comAdm++; }

// ---------- corretoras (cadastro de intermediários da CVM): o app guarda só o CNPJ lido na nota ----------
const cor = { ...(anterior.cor || {}) };
try {
  const { linhas, col } = csv('https://dados.cvm.gov.br/dados/INTERMED/CAD/DADOS/cad_intermed.zip', 'cad_intermed.csv');
  const iC = col('CNPJ'), iN = col('DENOM_SOCIAL'), iS = col('SIT'), iT = col('TP_PARTIC');
  const ativa = {};
  for (const x of linhas) {
    if (!/CORRETORA|DISTRIBUIDORA|BANCO/i.test(x[iT] || '')) continue;
    const c = so(x[iC]), ok = /NORMAL/i.test(x[iS] || '');
    if (/^0+$/.test(c) || (ativa[c] && !ok)) continue;
    cor[c] = limpo(x[iN]);
    if (ok) ativa[c] = true;
  }
} catch (e) { console.log(`corretoras: ${e.message}`); }

const novos = Object.keys(a).length;
for (const [tk, v] of Object.entries(anterior.a || {})) if (!a[tk]) a[tk] = v;
writeFileSync('site/cnpj.json', JSON.stringify({ atualizadoEm: agora.toISOString(), a, cor }));
console.log(`administrador de ${comAdm} fundos; ${Object.keys(cor).length} corretoras e distribuidoras`);
const semNada = Object.keys(cat).filter((tk) => !a[tk]);
console.log(`CNPJ: ${novos} ativos achados hoje (${Object.entries(por).map(([k, v]) => `${k} ${v}`).join(', ')}), ${Object.keys(a).length} publicados; do catálogo sem CNPJ: ${semNada.length}${semNada.length ? ` (${semNada.slice(0, 30).join(', ')}${semNada.length > 30 ? '...' : ''})` : ''}`);
if (existsSync('.cnpj.zip')) execSync('rm -f .cnpj.zip');
