// Busca a lista completa da B3 na brapi (2 consultas, cerca de 2.400 ativos) e gera os arquivos que o app lê:
//   site/cotacoes.json  { atualizadoEm, total, q: { TICKER: [preço, variação %] } }
//   site/catalogo.json  { versao, a: { TICKER: [nome, tipo, segmento, temLogo, volume] } }
import { mkdirSync, writeFileSync } from 'node:fs';

const MINIMO_ATIVOS = 1500; // abaixo disso a resposta veio incompleta: falha e o site continua com os dados anteriores
const FUSO = 'America/Sao_Paulo';

async function buscarLista() {
  const todos = [];
  for (let pagina = 1; pagina <= 3; pagina++) {
    let r;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      r = await fetch(`https://brapi.dev/api/quote/list?limit=2000&page=${pagina}`);
      if (r.ok) break;
      await new Promise((ok) => setTimeout(ok, 5000 * tentativa));
    }
    if (!r.ok) throw new Error(`brapi respondeu ${r.status} na página ${pagina}`);
    const j = await r.json();
    todos.push(...(j.stocks || []));
    if (!j.hasNextPage) break;
  }
  return todos;
}

// ---------- nomes, tipos e segmentos ----------
const MINUSCULAS = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'em', 'para']);
const SIGLAS = new Set(['B3', 'BTG', 'WEG', 'MRV', 'CEA', 'JBS', 'BRF', 'TIM', 'XP', 'BB', 'CSN', 'IRB', 'CPFL', 'EDP', 'SLC', 'PRIO', 'TAESA', 'BTLG', 'CEMIG', 'COPEL', 'SABESP', 'EQI', 'RBR', 'XPML']);

function titulo(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => {
      const up = p.toUpperCase();
      if (SIGLAS.has(up)) return up;
      if (i > 0 && MINUSCULAS.has(p)) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
}

function limparNome(nome, tk, sub) {
  if (!nome || nome === tk) return tk;
  let n = nome.toUpperCase();
  const tirar = [
    /FUNDO DE INVESTIMENTO (NAS CADEIAS PRODUTIVAS DO AGRONEG[OÓ]CIO|IMOBILI[AÁ]RIO)/g,
    /FUNDO DE [IÍ]NDICE/g,
    /CLASSE DE [IÍ]NDICE/g,
    /RESPONSABILIDADE LIMITADA/g,
    /\b(FII|FIAGRO|FI-AGRO|FIP|FIDC|ETF)\b/g,
    /\bS\.?\/?A\.?(?=\s|$|-)/g,
    /\bHOLDING\b/g,
    /\bPARTICIPA[CÇ](OES|ÕES)\b/g,
    /\bIMOBILI[AÁ]RIO\b/g,
  ];
  for (const re of tirar) n = n.replace(re, ' ');
  n = n.replace(/\s-(?=\S)/g, ' - ').replace(/\bBCO\b/g, 'BANCO');
  n = n.replace(/\s*[-.]\s*$/g, '').replace(/^\s*[-.]\s*/g, '').replace(/\s+-\s+-\s+/g, ' - ').replace(/\s+/g, ' ').trim();
  n = n.replace(/(\s-)+$/g, '').trim();
  if (!n) return tk;
  let t = titulo(n);
  if (sub === 'stock' || sub === 'unit') {
    const classe = tk.endsWith('11') ? 'Unit' : tk.endsWith('3') ? 'ON' : tk.endsWith('4') ? 'PN' : tk.endsWith('5') ? 'PNA' : tk.endsWith('6') ? 'PNB' : '';
    if (classe) t = `${t} ${classe}`;
  }
  return t.slice(0, 60);
}

function tipoDe(sub, type) {
  switch (sub) {
    case 'stock':
    case 'unit': return 'acao';
    case 'fii': return 'fii';
    case 'fi-agro': return 'fiagro';
    case 'etf': return 'etf';
    case 'bdr': return 'bdr';
    default: return type === 'bdr' ? 'bdr' : type === 'stock' ? 'acao' : 'fundo';
  }
}

const SEGMENTOS = {
  Finance: 'Financeiro', 'Energy Minerals': 'Petróleo e gás', Utilities: 'Energia e saneamento', 'Non-Energy Minerals': 'Mineração e siderurgia',
  'Retail Trade': 'Varejo', 'Health Services': 'Saúde', 'Consumer Services': 'Serviços', 'Consumer Non-Durables': 'Consumo',
  'Commercial Services': 'Serviços', 'Distribution Services': 'Distribuição', Transportation: 'Transporte', 'Technology Services': 'Tecnologia',
  'Process Industries': 'Indústria', Communications: 'Telecomunicações', 'Producer Manufacturing': 'Indústria', 'Electronic Technology': 'Tecnologia',
  'Industrial Services': 'Serviços industriais', 'Health Technology': 'Saúde', 'Consumer Durables': 'Bens duráveis', Miscellaneous: 'Outros',
};

function segmentoDe(it, tipo) {
  if (tipo === 'fii' || tipo === 'fiagro') return it.subsector || (tipo === 'fii' ? 'Imobiliário' : 'Agro');
  if (tipo === 'etf') return 'ETF';
  if (tipo === 'bdr') return 'BDR';
  return it.subsector || (it.sector ? SEGMENTOS[it.sector] || it.sector : '');
}

// ---------- geração ----------
const lista = (await buscarLista()).filter((it) => it.stock && typeof it.close === 'number' && it.close > 0);
if (lista.length < MINIMO_ATIVOS) throw new Error(`a brapi trouxe só ${lista.length} ativos`);

const q = {};
const a = {};
for (const it of lista) {
  q[it.stock] = [it.close, Math.round((it.change || 0) * 100) / 100];
  const tipo = tipoDe(it.subType, it.type);
  const temLogo = it.logo && !it.logo.endsWith('/BRAPI.svg') ? 1 : 0;
  a[it.stock] = [limparNome(it.name, it.stock, it.subType || ''), tipo, segmentoDe(it, tipo), temLogo, Math.round(it.volume || 0)];
}

const dia = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
mkdirSync('site', { recursive: true });
writeFileSync('site/cotacoes.json', JSON.stringify({ atualizadoEm: new Date().toISOString(), total: lista.length, q }));
writeFileSync('site/catalogo.json', JSON.stringify({ versao: dia, a }));
writeFileSync('site/index.html', '<!doctype html><meta charset="utf-8"><title>InfoBolsa dados</title><p>Dados de mercado usados pelo app InfoBolsa Investimentos.</p>');
console.log(`ok: ${lista.length} ativos`);
