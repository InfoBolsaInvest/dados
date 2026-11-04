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
const feito = existsSync('cache-b3/feito.json') ? JSON.parse(readFileSync('cache-b3/feito.json', 'utf8')) : {};
const marca = feito.dia || '';
// a rodada forçada de tarde (HISTORICO=1) não conta como a do dia: a do fechamento roda de novo
const doDia = marca === hoje && feito.depois !== false;
if (process.env.HISTORICO !== '1' && (doDia || (marca && minutosBR < 18 * 60 + 30))) { console.log('ok: histórico da B3 de hoje já feito'); process.exit(0); }

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

// lê um ano do arquivo da B3, linha a linha (o arquivo aberto passa de 500 MB): só mercado à vista. nomes junta o nome de
// pregão + especificação de cada ticker daquele ano (como sai na nota de corretagem): nota antiga traz só o nome, e
// fundo que mudou de nome ou saiu da bolsa só aparece nos anos em que negociou
const FORA_NOMES = new Set(['10', '22']); // direitos e recibos de subscrição (o b3.mjs tira os mesmos)
async function lerAno(ano, aoLer, nomes = null) {
  await baixar(ano);
  const unzip = spawn('unzip', ['-p', '.cotahist-ano.zip']);
  const fim = new Promise((ok) => unzip.on('close', ok));
  const linhas = createInterface({ input: unzip.stdout });
  for await (const l of linhas) {
    if (!l.startsWith('01') || l.slice(24, 27) !== '010') continue;
    const tk = l.slice(12, 24).trim();
    if (nomes && !FORA_NOMES.has(l.slice(10, 12)) && /^[A-Z0-9]{4}\d{1,2}$/.test(tk)) {
      const nome = `${l.slice(27, 39)} ${l.slice(39, 49)}`.split(/\s+/).filter((p) => p && !/^E[A-Z]{1,2}$/.test(p)).join(' ');
      if (nome && !(nomes[nome] || []).includes(tk)) nomes[nome] = [...(nomes[nome] || []), tk];
    }
    if (!cat[tk]) continue;
    const d = `${l.slice(2, 6)}-${l.slice(6, 8)}-${l.slice(8, 10)}`;
    const c = preco(l.slice(108, 121));
    if (!(c > 0)) continue;
    aoLer(tk, d, [preco(l.slice(56, 69)) || c, preco(l.slice(69, 82)) || c, preco(l.slice(82, 95)) || c, c]);
  }
  const codigo = await fim;
  if (codigo !== 0) throw new Error(`COTAHIST ${ano}: unzip saiu com ${codigo}`);
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
  const arq = `cache-b3/${ano}.json`, arqNomes = `cache-b3/nomes-${ano}.json`;
  if (existsSync(arq) && existsSync(arqNomes)) continue;
  const diario = {}, nomes = {};
  await lerAno(ano, (tk, d, v) => { (diario[tk] ||= []).push([d, ...v]); }, nomes);
  if (!existsSync(arq)) {
    const resumo = {};
    for (const [tk, l] of Object.entries(diario)) {
      l.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      resumo[tk] = { s: semanal(l), d: ano === anoAtual - 1 ? l.slice(-100) : [] };
    }
    writeFileSync(arq, JSON.stringify(resumo));
    console.log(`B3 ${ano}: ${Object.keys(resumo).length} ativos guardados`);
  }
  writeFileSync(arqNomes, JSON.stringify(nomes));
  writeFileSync('.b3anos-novo', '1'); // guarda no cache do Actions
}
const atual = {}, nomesAtual = {};
await lerAno(anoAtual, (tk, d, v) => { (atual[tk] ||= []).push([d, ...v]); }, nomesAtual);
// nomes de pregão de todos os anos no pregao.json (o b3.mjs junta os do dia a cada rodada e mantém os de antes)
{
  const pregao = existsSync('site/pregao.json') ? JSON.parse(readFileSync('site/pregao.json', 'utf8')) : {};
  const juntar = (m) => { for (const [nome, tks] of Object.entries(m)) pregao[nome] = [...new Set([...(pregao[nome] || []), ...tks])].sort(); };
  for (let ano = anoAtual - 5; ano < anoAtual; ano++) if (existsSync(`cache-b3/nomes-${ano}.json`)) juntar(JSON.parse(readFileSync(`cache-b3/nomes-${ano}.json`, 'utf8')));
  juntar(nomesAtual);
  writeFileSync('site/pregao.json', JSON.stringify(pregao));
  console.log(`nomes de pregão desde ${anoAtual - 5}: ${Object.keys(pregao).length}`);
}
const passados = [];
for (let ano = anoAtual - 5; ano < anoAtual; ano++) passados.push(JSON.parse(readFileSync(`cache-b3/${ano}.json`, 'utf8')));
const anterior = passados[passados.length - 1] || {};

// divide o preço de antes de cada evento pela proporção (desdobramento 1 para 4: o preço antigo vira 1/4). Na vela
// semanal (marcada na segunda), vale a sexta: a semana que fecha depois da data com já tem o preço novo.
const sexta = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 4); return x.toISOString().slice(0, 10); };
function ajustar(tk, linhas, semanal = false) {
  const evs = (fund[tk]?.e || []).filter((e) => e[2] > 0);
  if (!evs.length) return linhas;
  return linhas.map(([d, ...v]) => {
    const ref = semanal ? sexta(d) : d;
    const f = evs.filter((e) => ref <= e[0]).reduce((m, e) => m * e[2], 1);
    return f === 1 ? [d, ...v] : [d, ...v.map((x) => Math.round((x / f) * 1e4) / 1e4)];
  });
}

// desdobramento ou grupamento que a B3 não listou (acontece): um salto de uma vela para a outra numa proporção redonda
// (3, 4, 5, 10, 20... ou o inverso) que continua nas velas seguintes. Só proporções a partir de 3, bem perto da redonda:
// tombo de verdade (como -77% num dia) não é ajustado.
const REDONDAS = [3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100, 200];
function degraus(linhas) {
  const out = linhas.map((x) => [...x]);
  for (let i = out.length - 1; i >= 1; i--) {
    const r = out[i][4] / out[i - 1][4];
    const k = REDONDAS.find((n) => Math.abs(r * n - 1) < 0.06 || Math.abs(r / n - 1) < 0.06);
    if (!k) continue;
    const prop = r > 1 ? k : 1 / k;
    // o novo nível continua (a vela seguinte perto da de agora), senão é ponto errado e não degrau
    if (out[i + 1] && Math.abs(out[i + 1][4] / out[i][4] - 1) > 0.4) continue;
    if (out[i - 2] && Math.abs(out[i - 1][4] / out[i - 2][4] - 1) > 0.4) continue; // e o nível antigo vinha de antes
    for (let j = 0; j < i; j++) for (let c = 1; c <= 4; c++) out[j][c] = Math.round(out[j][c] * prop * 1e4) / 1e4;
  }
  return out;
}

mkdirSync('site/historico', { recursive: true });
mkdirSync('site/longo', { recursive: true });
const inicio5 = `${anoAtual - 5}${hoje.slice(4)}`;
let diarios = 0, semanais = 0;
for (const tk of Object.keys(cat)) {
  const doAno = (atual[tk] || []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // quem está na lista da brapi mas ficou sem arquivo (a brapi não trouxe) também sai daqui
  if (!daBrapi.has(tk) || !existsSync(`site/historico/${tk}.json`)) {
    const d = degraus(ajustar(tk, [...(anterior[tk]?.d || []), ...doAno])).slice(-66);
    if (d.length >= 5) { writeFileSync(`site/historico/${tk}.json`, JSON.stringify(d)); diarios++; }
  }
  if (!doYahoo.has(tk) || !existsSync(`site/longo/${tk}.json`)) {
    // o ano atual: ajusta o diário e depois junta em semanas; os anos passados já vêm semanais
    const s = [...ajustar(tk, passados.flatMap((p) => p[tk]?.s || []), true), ...semanal(ajustar(tk, doAno))].filter((x) => x[0] >= inicio5);
    // a semana da virada do ano pode vir em dois pedaços (um de cada arquivo): junta
    const juntas = [];
    for (const x of s) { const u = juntas[juntas.length - 1]; if (u && u[0] === x[0]) { u[2] = Math.max(u[2], x[2]); u[3] = Math.min(u[3], x[3]); u[4] = x[4]; } else juntas.push([...x]); }
    if (juntas.length > 10) { writeFileSync(`site/longo/${tk}.json`, JSON.stringify(degraus(juntas))); semanais++; }
  }
}
writeFileSync('cache-b3/feito.json', JSON.stringify({ dia: hoje, depois: minutosBR >= 18 * 60 + 30 }));
writeFileSync('.b3anos-novo', '1');
writeFileSync('.historico-novo', '1');
console.log(`B3: gráfico diário de ${diarios} e semanal de ${semanais} ativos que a brapi e o Yahoo não cobrem`);
