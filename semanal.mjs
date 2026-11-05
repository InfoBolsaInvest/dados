// Preço de cada ativo da B3 ao longo de até 20 anos (Yahoo Finanças, grátis), para o app calcular a rentabilidade da
// carteira pelas notas de corretagem (rentabilidade por cota, comparada com o CDI e o Ibovespa).
//   site/semanal/{TK}.json = { p: [[aaaa-mm-dd, fechamento]], s: [[aaaa-mm-dd, fator]] }
//   - p: semanal nos últimos 5 anos e mensal antes disso (o arquivo fica pequeno); fechamento ajustado pelos
//     desdobramentos e bonificações, como o Yahoo publica;
//   - s: esses desdobramentos e bonificações (fator 2 = cada ação virou 2), para o app voltar ao preço da época.
// Cada rodada atualiza até POR_RODADA ativos, começando pelos que nunca foram buscados e depois pelos mais antigos:
// cada ativo é renovado mais ou menos uma vez por semana, sem deixar a rodada lenta.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const POR_RODADA = 90;
const SEMANA = 7 * 86400 * 1000;
const UA = { 'user-agent': 'Mozilla/5.0 (InfoBolsa dados)' };
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const maisDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dia = (s, off = 0) => new Date(s * 1000 + off + 12 * 3600 * 1000).toISOString().slice(0, 10);

mkdirSync('site/semanal', { recursive: true });
const arqIndice = 'site/semanal/indice.json';
const indice = existsSync(arqIndice) ? JSON.parse(readFileSync(arqIndice, 'utf8')) : { em: {} };

const catalogo = Object.keys(JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a || {});
const todos = ['IBOV', ...catalogo];
const agora = Date.now();
// SO=AZUL3,BBAS3 busca só esses (teste)
const fila = process.env.SO ? process.env.SO.split(',') : todos
  .filter((tk) => !indice.em[tk] || agora - Date.parse(indice.em[tk]) > SEMANA)
  .sort((a, b) => (indice.em[a] || '').localeCompare(indice.em[b] || ''))
  .slice(0, process.env.SEMANAL === '1' ? 400 : POR_RODADA);

async function buscar(simbolo) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=20y&interval=1wk&events=split`, { headers: UA });
      if (r.status === 404) return null;
      if (r.ok) return (await r.json())?.chart?.result?.[0] || null;
      if (r.status === 429) await espera(15000);
    } catch {}
    await espera(2000 * tentativa);
  }
  return undefined; // falhou: tenta de novo numa rodada seguinte
}

let feitos = 0, sem = 0, falhas = 0;
for (const tk of fila) {
  const res = await buscar(tk === 'IBOV' ? '^BVSP' : `${tk}.SA`);
  if (res === undefined) { falhas++; await espera(500); continue; }
  indice.em[tk] = new Date().toISOString();
  const off = (res?.meta?.gmtoffset || 0) * 1000;
  const t = res?.timestamp || [];
  const c = res?.indicators?.quote?.[0]?.close || [];
  const semanas = [];
  t.forEach((s, i) => { if (c[i] > 0) semanas.push([dia(s, off), Math.round(c[i] * 10000) / 10000]); });
  // ponto errado do Yahoo: uma semana sozinha muito longe das duas vizinhas, que estão perto uma da outra
  const limpo = semanas.filter((v, i) => {
    const a = semanas[i - 1], b = semanas[i + 1];
    if (!a || !b || Math.abs(b[1] / a[1] - 1) > 0.2) return true;
    return Math.abs(v[1] / a[1] - 1) < 0.5;
  });
  const splits = Object.values(res?.events?.splits || {}).filter((x) => x.numerator > 0 && x.denominator > 0).map((x) => [dia(x.date, off), x.numerator / x.denominator]);
  // série que o Yahoo não ajustou (a Azul teve dois grupamentos em 2026 e o preço pula de R$ 7 para R$ 249): uma
  // semana que multiplica ou divide o preço por 4 ou mais, sem desdobramento do próprio Yahoo perto, não serve.
  // Sem o arquivo, o app estima pelas notas e avisa.
  const pulo = limpo.some((v, i) => {
    if (!i) return false;
    const r = v[1] / limpo[i - 1][1];
    if (r < 4 && r > 0.25) return false;
    return !splits.some(([d]) => d > limpo[i - 1][0] && d <= maisDias(v[0], 7));
  });
  if (limpo.length < 4 || pulo) {
    if (pulo) console.log(`semanal: ${tk} com salto sem ajuste, fica de fora`);
    if (existsSync(`site/semanal/${tk}.json`)) unlinkSync(`site/semanal/${tk}.json`);
    sem++; await espera(300); continue;
  }
  // mais de 5 anos atrás: só a última semana de cada mês
  const corte = new Date(agora - 5 * 365.25 * 86400 * 1000).toISOString().slice(0, 10);
  const p = limpo.filter((v, i) => v[0] >= corte || !limpo[i + 1] || limpo[i + 1][0].slice(0, 7) !== v[0].slice(0, 7));
  const s = Object.values(res?.events?.splits || {})
    .filter((x) => x.numerator > 0 && x.denominator > 0)
    .map((x) => [dia(x.date, off), Math.round((x.numerator / x.denominator) * 1e6) / 1e6])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  writeFileSync(`site/semanal/${tk}.json`, JSON.stringify({ p, s }));
  feitos++;
  await espera(300);
}
indice.atualizadoEm = new Date().toISOString();
writeFileSync(arqIndice, JSON.stringify(indice));
if (feitos || sem) writeFileSync('.historico-novo', '1');
const total = Object.keys(indice.em).length;
console.log(`semanal: ${feitos} atualizados, ${sem} sem histórico no Yahoo, ${falhas} falharam; ${total} de ${todos.length} já buscados`);
