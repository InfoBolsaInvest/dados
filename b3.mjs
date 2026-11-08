// Conferência com o arquivo oficial da B3 (COTAHIST do último pregão, grátis): todo ativo negociado
// no mercado à vista que não veio da brapi entra no catálogo, com o preço de fechamento da B3.
// Roda depois do atualizar.mjs: acrescenta o que a brapi não trouxe e, depois do pregão, troca o preço pelo fechamento
// oficial (veja embaixo). FECHAMENTO=1 força a troca, para testar.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// categorias da B3 que não são ativo pra acompanhar: 10 direitos de subscrição, 22 bônus de subscrição
const FORA = new Set(['10', '22']);
const TIPO = { '12': 'fii', '13': 'fii', '14': 'etf', '34': 'bdr', '35': 'bdr', '36': 'bdr' };

// o arquivo do último pregão (antes = 0) ou o do pregão anterior a uma data (antes = dias a pular a partir de hoje)
async function ultimoPregao(antes = 0) {
  for (let d = antes; d < antes + 7; d++) {
    const dia = new Date(Date.now() - 3 * 3600 * 1000 - d * 86400 * 1000);
    const nome = `COTAHIST_D${String(dia.getUTCDate()).padStart(2, '0')}${String(dia.getUTCMonth() + 1).padStart(2, '0')}${dia.getUTCFullYear()}`;
    const r = await fetch(`https://bvmf.bmfbovespa.com.br/InstDados/SerHist/${nome}.ZIP`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) continue;
    const zip = Buffer.from(await r.arrayBuffer());
    if (zip.length < 10000 || zip[0] !== 0x50) continue; // fim de semana/feriado: a B3 devolve uma página, não o zip
    writeFileSync('.cotahist.zip', zip);
    return { txt: execSync('unzip -p .cotahist.zip', { maxBuffer: 64 * 1024 * 1024 }).toString('latin1'), dia: dia.toISOString().slice(0, 10) };
  }
  throw new Error('arquivo da B3 não encontrado nos últimos 7 dias');
}

const { txt, dia } = await ultimoPregao();
const catalogo = JSON.parse(readFileSync('site/catalogo.json', 'utf8'));
const cotacoes = JSON.parse(readFileSync('site/cotacoes.json', 'utf8'));
const novos = [];
const oficial = {}; // ticker -> fechamento oficial da B3 no dia do arquivo
const isin = {}; // ticker -> código ISIN (o fundamentos.mjs liga os proventos da B3 ao ticker por ele)
// nome de pregão + especificação, como sai na nota de corretagem (ex.: "FIAGRO SUNO CI") -> tickers. O app usa quando a
// nota não traz o código. Junta com o que já estava publicado, porque o arquivo do dia só tem o que negociou nele.
const pregao = await fetch('https://infobolsainvest.github.io/dados/pregao.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
for (const l of txt.split(/\r?\n/)) {
  if (!l.startsWith('01') || l.slice(24, 27) !== '010') continue; // só mercado à vista
  const bdi = l.slice(10, 12);
  const tk = l.slice(12, 24).trim();
  isin[tk] = l.slice(230, 242).trim();
  const ult = Number(l.slice(108, 121)) / 100; // PREULT: o preço de fechamento oficial
  if (ult > 0 && /^[A-Z0-9]{4}\d{1,2}$/.test(tk)) oficial[tk] = ult;
  if (FORA.has(bdi) || !/^[A-Z0-9]{4}\d{1,2}$/.test(tk)) continue;
  // sem as marcas de "ex" da especificação (ER, EJ, ED...), que mudam de um dia para o outro
  const nome = `${l.slice(27, 39)} ${l.slice(39, 49)}`.split(/\s+/).filter((p) => p && !/^E[A-Z]{1,2}$/.test(p)).join(' ');
  if (nome && !(pregao[nome] || []).includes(tk)) pregao[nome] = [...(pregao[nome] || []), tk].sort();
  if (catalogo.a[tk] || tk === 'IBOV11') continue; // IBOV11 é o Ibovespa, não ativo
  const fech = Number(l.slice(108, 121)) / 100;
  const vol = Number(l.slice(152, 170)); // quantidade de ações negociadas (igual à da brapi; 170-188 é o volume em reais)
  if (!(fech > 0)) continue;
  // o nome fica igual ao ticker: o nomes.mjs busca o nome certo no Yahoo
  catalogo.a[tk] = [tk, TIPO[bdi] || (tk.endsWith('11') ? 'fii' : 'acao'), '', 0, vol];
  cotacoes.q[tk] = [fech, 0];
  novos.push(tk);
}
// o arquivo da B3 é do pregão anterior: a cotação de agora e a variação vêm do Yahoo, e o logo da brapi se existir
for (const tk of novos.slice(0, 30)) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${tk}.SA?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const m = r.ok ? (await r.json())?.chart?.result?.[0]?.meta : null;
    const ant = m?.chartPreviousClose || m?.previousClose;
    if (m?.regularMarketPrice > 0 && ant > 0) cotacoes.q[tk] = [m.regularMarketPrice, Math.round((m.regularMarketPrice / ant - 1) * 10000) / 100];
  } catch {}
  try { if ((await fetch(`https://icons.brapi.dev/icons/${tk}.svg`, { method: 'HEAD' })).ok) catalogo.a[tk][3] = 1; } catch {}
}
// Fechamento oficial: a brapi (e o Yahoo) às vezes fecham o dia com a última negociação antes do leilão de fechamento
// ou com um preço atrasado, e a carteira ficava uns centavos (às vezes bem mais) diferente da corretora. A B3 publica o
// arquivo do dia por volta das 20h30: daí em diante, e de manhã antes de o pregão abrir, vale o preço oficial dela.
// A variação do dia é refeita contra o fechamento anterior que a própria brapi usou.
const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
const minutosBR = agoraBR.getUTCHours() * 60 + agoraBR.getUTCMinutes();
// sábado e domingo também: não tem pregão, vale o último fechamento oficial
const usarOficial = process.env.FECHAMENTO === '1' || dia === agoraBR.toISOString().slice(0, 10) || minutosBR < 10 * 60 + 5 || agoraBR.getUTCDay() % 6 === 0;
let trocados = 0;
const grandes = [];
if (usarOficial) {
  // a variação do dia contra o fechamento oficial do pregão anterior (o arquivo de antes): é a conta das corretoras.
  // Sem ele, contra o fechamento anterior que a brapi usou
  // dias inteiros entre hoje e o dia do arquivo (pelas datas, não pelas horas: às 21h de sábado o arredondamento das
  // horas pulava a quinta e pegava a quarta), mais 1 para começar no dia anterior ao do arquivo
  const pulo = Math.round((Date.parse(`${agoraBR.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${dia}T00:00:00Z`)) / 86400000) + 1;
  const antes = {};
  try {
    const ant = await ultimoPregao(pulo);
    for (const l of ant.txt.split(/\r?\n/)) if (l.startsWith('01') && l.slice(24, 27) === '010') antes[l.slice(12, 24).trim()] = Number(l.slice(108, 121)) / 100;
    console.log(`B3: fechamento anterior de ${ant.dia}`);
  } catch (e) { console.log(`B3: sem o arquivo do pregão anterior (${e.message})`); }
  let viradas = 0;
  for (const [tk, fech] of Object.entries(oficial)) {
    const q = cotacoes.q[tk];
    if (!q || novos.includes(tk)) continue;
    const daBrapi = q[1] > -100 ? q[0] / (1 + q[1] / 100) : 0;
    // desdobramento ou grupamento no dia: o fechamento anterior da B3 não está ajustado, fica a variação da brapi
    const ofAnt = antes[tk] > 0 && Math.abs(fech / antes[tk] - 1) < 0.4 ? antes[tk] : 0;
    const anterior = ofAnt || daBrapi;
    const v = anterior > 0 ? Math.round((fech / anterior - 1) * 10000) / 100 : q[1];
    if (Math.abs(q[0] - fech) < 0.005 && Math.abs(q[1] - v) < 0.005) continue;
    if (Math.abs(q[0] / fech - 1) > 0.003) grandes.push(`${tk} ${q[0]}→${fech}`);
    if (Math.sign(q[1]) !== Math.sign(v) && v) viradas++;
    cotacoes.q[tk] = [fech, v];
    trocados++;
  }
  if (viradas) console.log(`B3: ${viradas} ativo(s) com a variação do dia trocando de sinal`);
  cotacoes.fechamentoOficial = dia;
  console.log(`B3: fechamento oficial de ${dia} em ${trocados} ativo(s)${grandes.length ? `; diferença acima de 0,3%: ${grandes.slice(0, 15).join(', ')}` : ''}`);
}
if (novos.length || usarOficial) {
  cotacoes.total = Object.keys(cotacoes.q).length;
  writeFileSync('site/catalogo.json', JSON.stringify(catalogo));
  writeFileSync('site/cotacoes.json', JSON.stringify(cotacoes));
}
writeFileSync('.isin.json', JSON.stringify(isin));
writeFileSync('site/pregao.json', JSON.stringify(pregao));
console.log(`B3: ${novos.length} ativo(s) que a brapi não trouxe${novos.length ? ': ' + novos.join(' ') : ''}`);
