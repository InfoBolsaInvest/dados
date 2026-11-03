// Carteiras dos clientes do acompanhamento que usam o Investidor10: 1x por dia, depois das 18h, lê o link
// público de cada um (campo i10 em carteiras/{uid}) e atualiza as posições sozinho no app.
// O link público não pede senha: é o próprio cliente que deixa a carteira visível e manda o link.
// Travas: leitura que falha, que vem vazia ou que "perde" mais da metade da carteira de uma vez não mexe em nada
// (provável instabilidade do site) e avisa no Telegram. Quando muda algo, avisa o dono no celular.
// I10=1 roda na hora, fora do horário.
import { readFileSync } from 'node:fs';

const PROJETO = 'infobolsa-investimentos';
const TOKEN = process.env.GOOGLE_TOKEN;
if (!TOKEN) { console.log('sem GOOGLE_TOKEN: pulei as carteiras do Investidor10'); process.exit(0); }
const FS = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIPOS = ['Ticker', 'Fii', 'Etf', 'Bdr']; // ações, FIIs (e Fiagro), ETFs e BDRs; renda fixa e Tesouro ainda não entram na carteira do app

const brt = new Date(Date.now() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
const forcar = process.env.I10 === '1';
if (!forcar && minutos < 18 * 60) { console.log('carteiras do Investidor10: só depois das 18h'); process.exit(0); }

const catalogo = JSON.parse(readFileSync('site/catalogo.json', 'utf8')).a;

function valor(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, valor(x)]));
  return null;
}
const num = (n) => (Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n });
const reais = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;

async function telegram(texto) {
  const { TELEGRAM_TOKEN: t, TELEGRAM_CHAT: c } = process.env;
  if (!t || !c) return;
  await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c, text: `📱 App InfoBolsa, carteiras do Investidor10\n\n${texto}` }) }).catch(() => {});
}

async function avisarDonos(titulo, texto) {
  const r = await fetch(`${FS}/config/avisos`, { headers: H });
  const donos = r.ok ? valor({ mapValue: { fields: (await r.json()).fields || {} } }).donos || [] : [];
  for (const uid of donos) {
    const u = await fetch(`${FS}/usuarios/${uid}`, { headers: H });
    const token = u.ok ? valor({ mapValue: { fields: (await u.json()).fields || {} } }).push?.token : null;
    if (!token) continue;
    await fetch(`https://fcm.googleapis.com/v1/projects/${PROJETO}/messages:send`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: { token, notification: { title: titulo, body: texto }, data: { tela: 'perfil' }, android: { priority: 'high', notification: { channel_id: 'avisos', color: '#FFB400' } } } }),
    }).catch(() => {});
  }
}

// link público: https://investidor10.com.br/wallet/public/{id}?h={hash}
function lerLink(link) {
  const m = /wallet\/public\/(\d+)[^?]*\?(?:.*&)?h=([0-9a-f]+)/i.exec(link || '');
  return m ? { id: m[1], hash: m[2] } : null;
}

// posições de um tipo; erro de leitura vira exceção (a carteira não é mexida)
async function posicoes(id, hash, tipo) {
  const out = [];
  for (let start = 0; start < 1000; start += 100) {
    const url = `https://investidor10.com.br/wallet/api/proxy/wallet-app/summary/actives/${id}/${tipo}?raw=1&selected_wallet_currency=BRL&api_version=v2&start=${start}&length=100&order_column=equity_total&order_dir=desc&hash=${hash}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'manual' });
    if (r.status !== 200) throw new Error(`${tipo}: resposta ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.data)) throw new Error(`${tipo}: formato mudou`);
    out.push(...j.data);
    if (j.data.length < 100) break;
  }
  return out;
}

const r = await fetch(`${FS}/carteiras?pageSize=300`, { headers: H });
if (!r.ok) throw new Error(`Firestore carteiras: ${r.status}`);
const carteiras = ((await r.json()).documents || [])
  .map((d) => ({ ...valor({ mapValue: { fields: d.fields || {} } }), uid: d.name.split('/').pop() }))
  .filter((c) => c.i10 && (forcar || c.i10Em !== hoje));
if (!carteiras.length) { console.log('carteiras do Investidor10: nada pra ler agora'); process.exit(0); }

let falhas = 0;
for (const c of carteiras) {
  const nome = c.nome || c.email || c.uid;
  const salvar = async (campos) => {
    const mask = Object.keys(campos).map((k) => `updateMask.fieldPaths=${k}`).join('&');
    const w = await fetch(`${FS}/carteiras/${c.uid}?${mask}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: campos }) });
    if (!w.ok) throw new Error(`gravar: ${w.status}`);
  };
  const link = lerLink(c.i10);
  if (!link) {
    await salvar({ i10Em: { stringValue: hoje }, i10Msg: { stringValue: 'Link do Investidor10 inválido: confira se é o link público da carteira.' } });
    await telegram(`Link inválido na carteira de ${nome}. Confira no painel.`);
    continue;
  }
  try {
    const lidos = (await Promise.all(TIPOS.map((t) => posicoes(link.id, link.hash, t)))).flat();
    const novo = {};
    const fora = [];
    for (const x of lidos) {
      const tk = String(x.ticker || '').toUpperCase().replace(/F$/, '');
      const q = Number(x.quantity), pm = Number(x.avg_price);
      if (!(q > 0) || !(pm > 0)) continue;
      if (!catalogo[tk]) { fora.push(tk); continue; }
      if (novo[tk]) { const t = novo[tk].q + q; novo[tk].pm = (novo[tk].pm * novo[tk].q + pm * q) / t; novo[tk].q = t; } else novo[tk] = { q, pm: Math.round(pm * 100) / 100 };
    }
    const velho = c.pos || {};
    const tksVelhos = Object.keys(velho).filter((tk) => velho[tk]?.q > 0);
    const custo = (p) => Object.values(p).reduce((s, x) => s + (x.q || 0) * (x.pm || 0), 0);
    // travas: vazio, ou mais da metade sumindo / metade do custo indo embora de uma vez
    const sumiram = tksVelhos.filter((tk) => !novo[tk]);
    const suspeito = !Object.keys(novo).length
      ? 'a leitura veio vazia'
      : tksVelhos.length >= 4 && sumiram.length > tksVelhos.length / 2
        ? `${sumiram.length} de ${tksVelhos.length} ativos sumiram de uma vez`
        : custo(velho) > 0 && custo(novo) < custo(velho) / 2 ? 'o valor investido caiu mais da metade de uma vez' : '';
    if (suspeito && tksVelhos.length) {
      await salvar({ i10Em: { stringValue: hoje }, i10Msg: { stringValue: `Não atualizei: ${suspeito}. Confira o Investidor10 e, se estiver certo, cole a lista no painel.` } });
      await telegram(`Carteira de ${nome}: não atualizei porque ${suspeito}. Pode ser instabilidade do site. Se a mudança for de verdade, cole a lista no painel.`);
      continue;
    }
    // o que mudou
    const mud = [];
    for (const [tk, x] of Object.entries(novo)) {
      const v = velho[tk];
      if (!v || !(v.q > 0)) mud.push(`${tk} entrou (${x.q})`);
      else if (v.q !== x.q) mud.push(`${tk}: ${v.q} → ${x.q}`);
      else if (Math.abs(v.pm - x.pm) > 0.01) mud.push(`${tk}: preço médio ${reais(v.pm)} → ${reais(x.pm)}`);
    }
    for (const tk of sumiram) mud.push(`${tk} saiu`);
    const obs = fora.length ? ` Fora da lista da B3 do app: ${fora.join(', ')}.` : '';
    const campos = { i10Em: { stringValue: hoje }, i10Msg: { stringValue: (mud.length ? `Atualizada: ${mud.join('; ')}.` : 'Sem mudança.') + obs } };
    if (mud.length) {
      campos.pos = { mapValue: { fields: Object.fromEntries(Object.entries(novo).map(([tk, x]) => [tk, { mapValue: { fields: { q: num(x.q), pm: num(x.pm) } } }])) } };
      campos.atualizadoEm = { timestampValue: new Date().toISOString() };
    }
    await salvar(campos);
    if (mud.length) await avisarDonos(`Carteira de ${nome} atualizada`, mud.slice(0, 6).join('\n') + (mud.length > 6 ? `\ne mais ${mud.length - 6}` : ''));
    console.log(`carteira ${c.uid.slice(0, 6)}…: ${mud.length ? `${mud.length} mudança(s)` : 'sem mudança'}${fora.length ? `, ${fora.length} fora do catálogo` : ''}`);
  } catch (e) {
    falhas++;
    console.log(`carteira ${c.uid.slice(0, 6)}…: não li o Investidor10 (${e.message})`);
    await salvar({ i10Msg: { stringValue: `Não consegui ler o Investidor10 hoje (${e.message}). Tento de novo na próxima rodada.` } }).catch(() => {});
  }
}
// falha de leitura deixa o passo vermelho: o aviso do Telegram (alerta.mjs) conta e avisa quando voltar
if (falhas) process.exit(1);
