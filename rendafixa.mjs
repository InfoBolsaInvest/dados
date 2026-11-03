// Renda fixa (uma vez por dia, na primeira rodada do dia), tudo de fonte oficial e grátis:
//   Banco Central (SGS): CDI de cada dia (12), IPCA de cada mês (433), Selic meta (432), CDI ao ano (4389), IPCA 12 meses (13522)
//   Tesouro Direto: preço e taxa de cada título em cada dia (Tesouro Transparente, dados abertos)
// Gera site/rendafixa.json { atualizadoEm, taxas, cdi: { ate, r: [[desde, % ao dia]] }, ipca: [[aaaa-mm, %]], uteis, tesouro: [...] }
// e site/tesouro/{id}.json com o histórico de cada título ([data, preço de compra, taxa de compra]): o app lê ao cadastrar,
// pra achar quanto custava o título no dia em que a pessoa comprou.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const SITE = 'https://infobolsainvest.github.io/dados';
const CSV_TESOURO = 'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';
const agora = new Date();
const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const hoje = diaBR(agora);

// o que já está publicado: se já rodou hoje, só republica (o histórico dos títulos volta do cache do Actions)
let anterior = null;
try { const r = await fetch(`${SITE}/rendafixa.json?x=${Date.now()}`); if (r.ok) anterior = await r.json(); } catch {}
if (anterior?.atualizadoEm && diaBR(new Date(anterior.atualizadoEm)) === hoje && existsSync('site/tesouro') && process.env.HISTORICO !== '1') {
  writeFileSync('site/rendafixa.json', JSON.stringify(anterior));
  console.log('ok: renda fixa de hoje já feita');
  process.exit(0);
}

// ---------- dias úteis (feriados nacionais, os mesmos da B3 e da ANBIMA) ----------
function pascoa(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
const isoDe = (t) => new Date(t).toISOString().slice(0, 10);
const feriadosDoAno = new Map();
function feriados(y) {
  if (!feriadosDoAno.has(y)) {
    const p = pascoa(y), dia = 86400000;
    const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25', ...(y >= 2024 ? ['11-20'] : [])].map((md) => `${y}-${md}`);
    feriadosDoAno.set(y, new Set([...fixos, isoDe(p - 48 * dia), isoDe(p - 47 * dia), isoDe(p - 2 * dia), isoDe(p + 60 * dia)]));
  }
  return feriadosDoAno.get(y);
}
const util = (iso) => { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !feriados(+iso.slice(0, 4)).has(iso); };
const proximo = (iso) => isoDe(Date.parse(iso + 'T12:00:00Z') + 86400000);

// ---------- Banco Central ----------
const br = (iso) => iso.split('-').reverse().join('/');
const deBr = (s) => s.split('/').reverse().join('-');
async function sgs(serie, de, ate) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${br(de)}&dataFinal=${br(ate)}`);
      if (!r.ok) throw new Error(`SGS ${serie}: ${r.status}`);
      return (await r.json()).map((x) => [deBr(x.data), Number(x.valor)]);
    } catch (e) {
      if (t >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * t));
    }
  }
}
const ultimoValor = async (serie) => (await sgs(serie, isoDe(agora.getTime() - 400 * 86400000), hoje)).at(-1);

// CDI de cada dia útil desde 2012 (a série diária só sai em pedaços de até 10 anos)
const cdiDias = [];
for (let ano = 2012; ano <= +hoje.slice(0, 4); ano += 5) cdiDias.push(...(await sgs(12, `${ano}-01-01`, `${Math.min(ano + 4, +hoje.slice(0, 4))}-12-31`)));
if (cdiDias.length < 3000) throw new Error(`CDI veio curto: ${cdiDias.length} dias`);
// guarda só quando a taxa muda (muda pouco: nas reuniões do Copom)
const cdiR = [];
for (const [d, v] of cdiDias) if (!cdiR.length || cdiR.at(-1)[1] !== v) cdiR.push([d, v]);

// confere os feriados calculados com os dias que o Banco Central publicou; o que não bater vai pro app corrigir
const temCdi = new Set(cdiDias.map(([d]) => d));
const uteis = { mais: [], menos: [] }; // mais: dia útil que a conta achava feriado; menos: feriado extra
for (let d = cdiDias[0][0]; d <= cdiDias.at(-1)[0]; d = proximo(d)) {
  if (util(d) && !temCdi.has(d)) uteis.menos.push(d);
  if (!util(d) && temCdi.has(d)) uteis.mais.push(d);
}
if (uteis.menos.length + uteis.mais.length) console.log(`dias úteis fora da conta: ${JSON.stringify(uteis)}`);

// IPCA de cada mês desde 2000 (base do valor nominal do Tesouro IPCA+)
const ipca = (await sgs(433, '2000-01-01', hoje)).map(([d, v]) => [d.slice(0, 7), v]);
const taxas = {
  selic: (await ultimoValor(432))[1],
  cdi: (await ultimoValor(4389))[1],
  ipca12: (await ultimoValor(13522))[1],
  ipcaMes: ipca.at(-1),
};

// ---------- Tesouro Direto ----------
const TIPOS = {
  'Tesouro Selic': ['selic', 0],
  'Tesouro Prefixado': ['pre', 0],
  'Tesouro Prefixado com Juros Semestrais': ['pre-js', 0],
  'Tesouro IPCA+': ['ipca', 0],
  'Tesouro IPCA+ com Juros Semestrais': ['ipca-js', 0],
  'Tesouro Renda+ Aposentadoria Extra': ['renda', 19], // o nome usa o ano em que começam os pagamentos
  'Tesouro Educa+': ['educa', 4],
};
const num = (s) => Number(String(s).replace(',', '.')) || 0;
let csv = '';
for (let t = 1; t <= 3 && !csv; t++) {
  try { const r = await fetch(CSV_TESOURO); if (r.ok) csv = await r.text(); } catch {}
  if (!csv) await new Promise((ok) => setTimeout(ok, 5000 * t));
}
if (!csv) throw new Error('Tesouro Transparente não respondeu');
const corte = isoDe(Date.parse(hoje) - 60 * 86400000); // título vencido fica 60 dias, pra quem tinha ver o valor final
const titulos = new Map();
for (const linha of csv.split(/\r?\n/).slice(1)) {
  const [tipo, venc, data, tc, tv, puc, , pub] = linha.split(';');
  if (!TIPOS[tipo] || !venc) continue;
  const v = deBr(venc);
  if (v < corte) continue;
  const id = `${TIPOS[tipo][0]}-${v}`;
  if (!titulos.has(id)) titulos.set(id, { id, tipo: TIPOS[tipo][0], nome: `${tipo} ${+v.slice(0, 4) - TIPOS[tipo][1]}`, venc: v, dias: [] });
  titulos.get(id).dias.push([deBr(data), num(puc), num(tc), num(pub), num(tv)]);
}

// valor nominal do Tesouro IPCA+ (base R$ 1.000 em 15/07/2000, corrigido pelo IPCA de cada mês até o mês anterior)
function vna(dataCupom) {
  const ate = dataCupom.slice(0, 7);
  let v = 1000;
  for (const [m, p] of ipca) if (m >= '2000-07' && m < ate) v *= 1 + p / 100;
  return v;
}
const CUPOM_PRE = 1000 * (Math.sqrt(1.1) - 1); // 10% ao ano, pago a cada 6 meses
const CUPOM_IPCA = Math.sqrt(1.06) - 1; // 6% ao ano sobre o valor nominal

mkdirSync('site/tesouro', { recursive: true });
const tesouro = [];
for (const t of titulos.values()) {
  t.dias.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const u = t.dias.at(-1);
  // juros semestrais já pagos (por título): o app soma os que caíram depois da compra
  const cupons = [];
  if (t.tipo === 'pre-js' || t.tipo === 'ipca-js') {
    const meses = t.tipo === 'pre-js' ? ['01', '07'] : t.venc.slice(5, 7) === '05' ? ['05', '11'] : ['02', '08'];
    const dia = t.tipo === 'pre-js' ? '01' : '15';
    for (let y = +t.dias[0][0].slice(0, 4); y <= +hoje.slice(0, 4); y++) {
      for (const m of meses) {
        const d = `${y}-${m}-${dia}`;
        if (d <= t.dias[0][0] || d > hoje || d > t.venc) continue;
        cupons.push([d, Math.round((t.tipo === 'pre-js' ? CUPOM_PRE : vna(d) * CUPOM_IPCA) * 100) / 100]);
      }
    }
  }
  tesouro.push({ id: t.id, tipo: t.tipo, nome: t.nome, venc: t.venc, data: u[0], pu: u[3], taxaCompra: u[2], taxaVenda: u[4], aVenda: u[1] > 0, ...(cupons.length ? { cupons } : {}) });
  // histórico: [data, preço de compra (ou o de mercado, quando não estava à venda), taxa]
  writeFileSync(`site/tesouro/${t.id}.json`, JSON.stringify(t.dias.map(([d, puc, tc, pub, tv]) => [d, puc || pub, tc || tv])));
}
const ORDEM = ['selic', 'pre', 'ipca', 'pre-js', 'ipca-js', 'renda', 'educa'];
tesouro.sort((a, b) => ORDEM.indexOf(a.tipo) - ORDEM.indexOf(b.tipo) || (a.venc < b.venc ? -1 : 1));
if (tesouro.length < 20) throw new Error(`Tesouro veio curto: ${tesouro.length} títulos`);

writeFileSync('site/rendafixa.json', JSON.stringify({
  atualizadoEm: agora.toISOString(),
  taxas,
  cdi: { ate: cdiDias.at(-1)[0], r: cdiR },
  ipca: ipca.filter(([m]) => m >= '2012-01'),
  uteis,
  tesouro,
}));
writeFileSync('.historico-novo', '1'); // guarda site/tesouro no cache do Actions
console.log(`ok: renda fixa (CDI até ${cdiDias.at(-1)[0]}, IPCA até ${ipca.at(-1)[0]}, ${tesouro.length} títulos do Tesouro, Selic ${taxas.selic}%)`);
