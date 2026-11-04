// Gráfico de todos os ativos que a brapi e o Yahoo não cobrem (FIIs menores, Fiagros, ações pouco negociadas), pelo
// arquivo oficial da B3 com todos os pregões do ano (COTAHIST anual, grátis, atualizado todo dia):
//   site/historico/TK.json [[aaaa-mm-dd, abertura, máxima, mínima, fechamento], ...] (3 meses, diário)
//   site/longo/TK.json     o mesmo, semanal (segunda-feira da semana), 5 anos
// O preço da B3 não vem ajustado: antes de um desdobramento, grupamento ou bonificação (eventos da B3 no
// fundamentos.json), o preço é dividido pela proporção, senão o gráfico mostra um degrau que não existiu.
// O ano atual é baixado uma vez por dia (depois das 18h30); os anos passados, uma vez só, e ficam resumidos em
// cache-b3/ (cache do Actions, junto com o histórico).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const diaBR = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const agora = new Date();
const hoje = diaBR(agora);
const minutosBR = ((agora.getUTCHours() + 21) % 24) * 60 + agora.getUTCMinutes();
mkdirSync('cache-b3', { recursive: true });
const marca = existsSync('cache-b3/feito.json') ? JSON.parse(readFileSync('cache-b3/feito.json', 'utf8')).dia : '';
if (process.env.HISTORICO !== '1' && (marca === hoje || (marca && minutosBR < 18 * 60 + 30))) { console.log('ok: histórico da B3 de hoje já feito'); process.exit(0); }

const cat = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;
const fund = existsSync('site/fundamentos.json') ? JSON.parse(readFileSync('site/fundamentos.json', 'utf8')).a : {};
const lerIndice = (arq) => { try { return new Set(JSON.parse(readFileSync(arq, 'utf8')).tickers || []); } catch { return new Set(); } };
const daBrapi = lerIndice('site/historico/indice.json'); // esses já têm o diário
const doYahoo = lerIndice('site/longo/indice.json'); // e esses o semanal

const segunda = (iso) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const preco = (s) => Number(s) / 100;

// baixa o arquivo do ano; a B3 às vezes corta a conexão no meio (arquivo de 100 MB): tenta de novo
async function baixar(ano) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const r = await fetch(`https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A${ano}.ZIP`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(String(r.status));
      writeFileSync('.cotahist-ano.zip', Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) {
      if (tentativa >= 4) throw new Error(`COTAHIST ${ano}: ${e.message}`);
      console.log(`COTAHIST ${ano}: ${e.message}, tentando de novo`);
      await new Promise((ok) => setTimeout(ok, 30000 * tentativa));
    }
  }
}

// lê um ano do arquivo da B3, linha a linha (o arquivo aberto passa de 500 MB): só mercado à vista
async function lerAno(ano, aoLer) {
  await baixar(ano);
  const unzip = spawn('unzip', ['-p', '.cotahist-ano.zip']);
  const linhas = createInterface({ input: unzip.stdout });
  for await (const l of linhas) {
    if (!l.startsWith('01') || l.slice(24, 27) !== '010') continue;
    const tk = l.slice(12, 24).trim();
    if (!cat[tk]) continue;
    const d = `${l.slice(2, 6)}-${l.slice(6, 8)}-${l.slice(8, 10)}`;
    const c = preco(l.slice(108, 121));
    if (!(c > 0)) continue;
    aoLer(tk, d, [preco(l.slice(56, 69)) || c, preco(l.slice(69, 82)) || c, preco(l.slice(82, 95)) || c, c]);
  }
}

// junta os pregões em semanas: abertura da primeira, máxima, mínima e fechamento da última
function semanal(diario) {
  const m = new Map();
  for (const [d, o, h, l, c] of diario) {
    const s = segunda(d);
    const x = m.get(s);
    if (!x) m.set(s, [s, o, h, l, c]);
    else { x[2] = Math.max(x[2], h); x[3] = Math.min(x[3], l); x[4] = c; }
  }
  return [...m.values()];
}

const anoAtual = Number(hoje.slice(0, 4));
// anos passados: uma vez só (semanal de todos e o diário dos últimos 100 dias do ano anterior, para janeiro a março)
for (let ano = anoAtual - 5; ano < anoAtual; ano++) {
  const arq = `cache-b3/${ano}.json`;
  if (existsSync(arq)) continue;
  const diario = {};
  await lerAno(ano, (tk, d, v) => { (diario[tk] ||= []).push([d, ...v]); });
  const resumo = {};
  for (const [tk, l] of Object.entries(diario)) {
    l.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    resumo[tk] = { s: semanal(l), d: ano === anoAtual - 1 ? l.slice(-100) : [] };
  }
  writeFileSync(arq, JSON.stringify(resumo));
  writeFileSync('.b3anos-novo', '1'); // guarda no cache do Actions
  console.log(`B3 ${ano}: ${Object.keys(resumo).length} ativos guardados`);
}
const atual = {};
await lerAno(anoAtual, (tk, d, v) => { (atual[tk] ||= []).push([d, ...v]); });
const passados = [];
for (let ano = anoAtual - 5; ano < anoAtual; ano++) passados.push(JSON.parse(readFileSync(`cache-b3/${ano}.json`, 'utf8')));
const anterior = passados[passados.length - 1] || {};

// divide o preço de antes de cada evento pela proporção (desdobramento 1 para 4: o preço antigo vira 1/4)
function ajustar(tk, linhas) {
  const evs = (fund[tk]?.e || []).filter((e) => e[2] > 0);
  if (!evs.length) return linhas;
  return linhas.map(([d, ...v]) => {
    const f = evs.filter((e) => d <= e[0]).reduce((m, e) => m * e[2], 1);
    return f === 1 ? [d, ...v] : [d, ...v.map((x) => Math.round((x / f) * 1e4) / 1e4)];
  });
}

mkdirSync('site/historico', { recursive: true });
mkdirSync('site/longo', { recursive: true });
const inicio5 = `${anoAtual - 5}${hoje.slice(4)}`;
let diarios = 0, semanais = 0;
for (const tk of Object.keys(cat)) {
  const doAno = (atual[tk] || []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!daBrapi.has(tk)) {
    const d = ajustar(tk, [...(anterior[tk]?.d || []), ...doAno]).slice(-66);
    if (d.length >= 5) { writeFileSync(`site/historico/${tk}.json`, JSON.stringify(d)); diarios++; }
  }
  if (!doYahoo.has(tk)) {
    const s = ajustar(tk, [...passados.flatMap((p) => p[tk]?.s || []), ...semanal(doAno)].filter((x) => x[0] >= inicio5));
    // a semana da virada do ano pode vir em dois pedaços (um de cada arquivo): junta
    const juntas = [];
    for (const x of s) { const u = juntas[juntas.length - 1]; if (u && u[0] === x[0]) { u[2] = Math.max(u[2], x[2]); u[3] = Math.min(u[3], x[3]); u[4] = x[4]; } else juntas.push([...x]); }
    if (juntas.length > 10) { writeFileSync(`site/longo/${tk}.json`, JSON.stringify(juntas)); semanais++; }
  }
}
writeFileSync('cache-b3/feito.json', JSON.stringify({ dia: hoje }));
writeFileSync('.b3anos-novo', '1');
writeFileSync('.historico-novo', '1');
console.log(`B3: gráfico diário de ${diarios} e semanal de ${semanais} ativos que a brapi e o Yahoo não cobrem`);
