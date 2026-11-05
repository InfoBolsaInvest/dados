// Carteiras dos clientes do acompanhamento que usam o Investidor10: 1x por dia, depois das 18h, lê o link
// público de cada um (campo i10 em carteiras/{uid}) e atualiza sozinho no app as posições (ações, FIIs, ETFs,
// BDRs) e a renda fixa (Tesouro e CDB/LCI/LCA..., cada aplicação com a data, pelos lançamentos).
// O link público não pede senha: é o próprio cliente que deixa a carteira visível e manda o link.
// Travas: leitura que falha, que vem vazia ou que "perde" mais da metade da carteira de uma vez não mexe em nada
// (provável instabilidade do site) e avisa no Telegram. Quando muda algo, avisa o dono no celular.
// I10=1 roda na hora, fora do horário (I10=2 também força a conferência da IA).
import { readFileSync } from 'node:fs';

const PROJETO = 'infobolsa-investimentos';
const TOKEN = process.env.GOOGLE_TOKEN;
if (!TOKEN) { console.log('sem GOOGLE_TOKEN: pulei as carteiras do Investidor10'); process.exit(0); }
const FS = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIPOS = ['Ticker', 'Fii', 'Etf', 'Bdr']; // ações, FIIs (e Fiagro), ETFs e BDRs; Tesouro e renda fixa vêm à parte (rendaFixa); cripto não entra

const brt = new Date(Date.now() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
const forcar = ['1', '2'].includes(process.env.I10); // 2 = também roda a conferência da IA mesmo sem mudança (teste)
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
  await avisarContas(donos, titulo, texto, 'perfil');
}

// push pro celular registrado em cada conta (usuarios/{uid}.push)
async function avisarContas(uids, titulo, texto, tela) {
  for (const uid of uids) {
    const u = await fetch(`${FS}/usuarios/${uid}`, { headers: H });
    const token = u.ok ? valor({ mapValue: { fields: (await u.json()).fields || {} } }).push?.token : null;
    if (!token) continue;
    await fetch(`https://fcm.googleapis.com/v1/projects/${PROJETO}/messages:send`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: { token, notification: { title: titulo, body: texto }, data: { tela }, android: { priority: 'high', notification: { channel_id: 'avisos', color: '#FFB400' } } } }),
    }).catch(() => {});
  }
}

// link público: https://investidor10.com.br/wallet/public/{id}?h={hash}
// (carteira aberta a todos vem sem o "?h=": aí o código fica vazio e a leitura funciona igual)
function lerLink(link) {
  const m = /wallet\/public\/(\d+)/i.exec(link || '');
  if (!m) return null;
  const h = /[?&]h=([0-9a-f]+)/i.exec(link);
  return { id: m[1], hash: h ? h[1] : '' };
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

// lançamentos (compras e vendas, com data) de um grupo: 3 = renda fixa (CDB, LCI...), 5 = Tesouro Direto
async function lancamentos(id, hash, grupo) {
  const out = [];
  for (let start = 0; start < 2000; start += 100) {
    const r = await fetch(`https://investidor10.com.br/wallet/api/proxy/wallet-app/entries/${id}/${grupo}?length=100&start=${start}&orderBy=date&raw=1&hash=${hash}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'manual' });
    if (r.status !== 200) throw new Error(`lançamentos ${grupo}: resposta ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.data)) throw new Error(`lançamentos ${grupo}: formato mudou`);
    out.push(...j.data);
    if (j.data.length < 100) break;
  }
  return out;
}

// ---------- renda fixa: cada aplicação que ainda está na carteira vira um item da renda fixa do app ----------
const rfdados = (() => { try { return JSON.parse(readFileSync('site/rendafixa.json', 'utf8')); } catch { return { tesouro: [] }; } })();
const iso = (br) => (/^\d{2}\/\d{2}\/\d{4}$/.test(br || '') ? `${br.slice(6)}-${br.slice(3, 5)}-${br.slice(0, 2)}` : '');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// tipo do título pelo nome, do jeito do app (selic, pre, pre-js, ipca, ipca-js, renda, educa)
function tipoTesouro(nome) {
  const n = semAcento(nome);
  const js = /JUROS/.test(n);
  if (/SELIC/.test(n)) return 'selic';
  if (/RENDA\+|RENDA MAIS/.test(n)) return 'renda';
  if (/EDUCA/.test(n)) return 'educa';
  if (/IPCA/.test(n)) return js ? 'ipca-js' : 'ipca';
  if (/PREFIXADO/.test(n)) return js ? 'pre-js' : 'pre';
  return '';
}
const indDoTipo = (t) => (t === 'selic' ? 'selic' : t.startsWith('pre') ? 'pre' : 'ipca');
// taxa de compra do título no dia (histórico publicado pelo rendafixa.mjs: [dia, PU, taxa])
function taxaNoDia(id, dia) {
  try {
    const linhas = JSON.parse(readFileSync(`site/tesouro/${id}.json`, 'utf8'));
    let t = null;
    for (const [d, , tx] of linhas) { if (d <= dia) t = tx; else break; }
    return t ?? 0;
  } catch { return 0; }
}
// das compras (mais nova primeiro), pega até completar o que ainda está na carteira; a mais antiga pode entrar só em parte
function lotesAtuais(compras, total, medida) {
  const out = [];
  let falta = total;
  for (const x of [...compras].sort((a, b) => (iso(a.date) < iso(b.date) ? 1 : -1))) {
    if (falta <= 1e-9) break;
    const m = medida(x);
    const usa = Math.min(m, falta);
    out.push({ x, parte: m > 0 ? usa / m : 0 });
    falta -= usa;
  }
  return out;
}
const PRODUTOS = ['CDB', 'LCI', 'LCA', 'LC', 'CRI', 'CRA', 'Debênture'];

async function rendaFixa(id, hash) {
  const [tesPos, fixPos, tesLanc, fixLanc] = await Promise.all([posicoes(id, hash, 'Treasure'), posicoes(id, hash, 'FixedIncome'), lancamentos(id, hash, 5), lancamentos(id, hash, 3)]);
  const rf = [];
  const fora = [];
  const entendido = []; // nome no Investidor10 → como o robô entendeu (vai pra conferência da IA)
  // Tesouro: quantidade atual de cada título, montada a partir das compras mais recentes (o mesmo título em
  // duas posições é somado antes, pelo mesmo motivo da renda fixa abaixo)
  const titulos = new Map();
  for (const p of tesPos) {
    const ja = titulos.get(semAcento(p.ticker));
    if (ja) ja.quantity = String(Number(ja.quantity) + Number(p.quantity)); else titulos.set(semAcento(p.ticker), { ...p });
  }
  for (const p of titulos.values()) {
    const q = Number(p.quantity);
    if (!(q > 0)) continue;
    const compras = tesLanc.filter((x) => x.type === 'Compra' && semAcento(x.ticker) === semAcento(p.ticker));
    const venc = iso(compras[0]?.due_date);
    const tipo = tipoTesouro(p.ticker);
    const t = rfdados.tesouro.find((y) => y.tipo === tipo && y.venc === venc);
    if (!t) { fora.push(p.ticker); continue; }
    entendido.push(`"${p.ticker}" → ${t.nome}, vence ${t.venc}, ${q} títulos`);
    for (const { x, parte } of lotesAtuais(compras, q, (y) => Number(y.qty))) {
      const qtd = Number(x.qty) * parte;
      const dia = iso(x.date);
      rf.push({ id: `cart-${t.id}-${dia}-${x.id}`, produto: 'Tesouro', nome: t.nome, ind: indDoTipo(t.tipo), taxa: taxaNoDia(t.id, dia), valor: Math.round(qtd * Number(x.price_raw) * 100) / 100, data: dia, venc: t.venc, isento: false, titulo: t.id, qtd });
    }
  }
  // CDB, LCI, LCA...: valor aplicado atual, montado a partir das aplicações mais recentes. Posições com o mesmo
  // nome (o Investidor10 às vezes separa o mesmo CDB em duas) são juntadas antes, senão as mesmas aplicações
  // entrariam duas vezes
  const porNome = new Map();
  for (const p of fixPos) {
    const ja = porNome.get(p.ticker);
    if (ja) ja.applied = String(Number(ja.applied) + Number(p.applied)); else porNome.set(p.ticker, { ...p });
  }
  for (const p of porNome.values()) {
    const aplicado = Number(p.applied);
    if (!(aplicado > 0)) continue;
    const compras = fixLanc.filter((x) => x.type === 'Compra' && x.ticker === p.ticker);
    const produto = PRODUTOS.find((y) => semAcento(y) === semAcento(p.investment_type)) || 'Outro';
    // o tipo de taxa manda: pré-fixado vem com indexer "CDI" no Investidor10 (ex.: "CDB C6 Pré-Fixado 1,68%")
    const indexador = semAcento(p.indexer);
    const ind = semAcento(p.rate_type) === 'PRE' ? 'pre' : /IPCA/.test(indexador) ? 'ipca' : /SELIC/.test(indexador) ? 'selic' : /CDI/.test(indexador) ? 'cdi' : 'pre';
    const taxa = ind === 'cdi' ? Number(p.percentage_cdi) : Number(p.percentage_year) || 0;
    if (!compras.length) { fora.push(p.ticker); continue; }
    entendido.push(`"${p.ticker}" → ${produto} ${p.emitter || ''}, ${ind === 'cdi' ? `${taxa}% do CDI` : ind === 'pre' ? `pré-fixado ${taxa}% ao ano` : ind === 'ipca' ? `IPCA + ${taxa}%` : `Selic + ${taxa}%`}, ${['LCI', 'LCA', 'CRI', 'CRA'].includes(produto) ? 'isento de IR' : 'com IR'}, aplicado R$ ${aplicado}`);
    for (const { x, parte } of lotesAtuais(compras, aplicado, (y) => Number(y.total_raw))) {
      const dia = iso(x.date);
      rf.push({ id: `cart-fixa-${dia}-${x.id}`, produto, nome: p.emitter || '', ind, taxa, valor: Math.round(Number(x.total_raw) * parte * 100) / 100, data: dia, venc: iso(x.due_date), isento: ['LCI', 'LCA', 'CRI', 'CRA'].includes(produto) });
    }
  }
  rf.sort((a, b) => (a.data < b.data ? -1 : 1));
  return { rf, fora, entendido };
}
// Conferência da importação pela IA (Claude Haiku, esforço baixo): olha o nome original de cada item e como o
// robô entendeu. Volta a lista do que parece errado (vazia se está tudo certo ou se a IA não respondeu).
async function conferir(entendido, fora, rfFora) {
  if (!process.env.ANTHROPIC_API_KEY || !entendido.length) return [];
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const r = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 1500,
      system: 'Você confere a importação de renda fixa de uma carteira do Investidor10 para um app. Cada linha traz o nome original do item e como o robô entendeu. Liste só erros claros: quando o nome original diz uma coisa e o robô entendeu outra (tipo de produto, pré ou pós-fixado, indexador, taxa, isenção de IR). Informação que o nome não traz não é erro. Grafia diferente do emissor não é erro. Se não houver erro claro, devolva a lista vazia. Nunca liste o que está certo nem faça observações. Cada erro em uma frase curta, em português do Brasil, sem travessão.',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { problemas: { type: 'array', items: { type: 'string' } } }, required: ['problemas'], additionalProperties: false } } },
      messages: [{ role: 'user', content: [...entendido, ...(fora.length || rfFora.length ? [`Não entraram: ${[...fora, ...rfFora].join(', ')}`] : [])].join('\n') }],
    });
    if (r.stop_reason !== 'end_turn') return [];
    const j = JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{}');
    return (j.problemas || []).map((p) => String(p).replace(/\s*[—–]\s*/g, ', ').trim()).filter(Boolean).slice(0, 8);
  } catch (e) {
    console.log(`conferência da IA: ${e.message}`);
    return [];
  }
}

// JSON comum → formato do Firestore
const paraFs = (v) => (v === null || v === undefined ? { nullValue: null }
  : typeof v === 'string' ? { stringValue: v }
    : typeof v === 'boolean' ? { booleanValue: v }
      : typeof v === 'number' ? num(v)
        : Array.isArray(v) ? { arrayValue: { values: v.map(paraFs) } }
          : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, paraFs(x)])) } });

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
    // renda fixa (Tesouro, CDB, LCI...): compara pelo que importa pro app
    const { rf, fora: rfFora, entendido } = await rendaFixa(link.id, link.hash);
    const chaveRf = (l) => JSON.stringify((l || []).map((x) => [x.produto, x.nome, x.ind, x.taxa, x.valor, x.data, x.venc, x.isento, x.qtd ?? null]));
    // trava: a renda fixa toda sumindo de uma vez é mais provável erro de leitura do que venda de tudo
    const rfSumiu = !rf.length && (c.rf || []).length > 0;
    const rfMudou = !rfSumiu && chaveRf(rf) !== chaveRf(c.rf);
    if (rfSumiu) rfFora.push('a renda fixa veio vazia, mantive a anterior');
    if (rfMudou) mud.push(`renda fixa: ${rf.length} ${rf.length === 1 ? 'aplicação' : 'aplicações'}`);
    const obs = (fora.length ? ` Fora da lista da B3 do app: ${fora.join(', ')}.` : '') + (rfFora.length ? ` Renda fixa que não entrou: ${rfFora.join(', ')}.` : '');
    const campos = { i10Em: { stringValue: hoje }, i10Msg: { stringValue: (mud.length ? `Atualizada: ${mud.join('; ')}.` : 'Sem mudança.') + obs } };
    if (mud.length) {
      campos.pos = { mapValue: { fields: Object.fromEntries(Object.entries(novo).map(([tk, x]) => [tk, { mapValue: { fields: { q: num(x.q), pm: num(x.pm) } } }])) } };
      campos.rf = paraFs(rfSumiu ? c.rf : rf);
      campos.atualizadoEm = { timestampValue: new Date().toISOString() };
    }
    // conferência pela IA (só quando mudou algo): avisa se algum item parece mal entendido; não muda nada
    const duvidas = mud.length || process.env.I10 === '2' ? await conferir(entendido, fora, rfFora) : [];
    // o log das Actions é público (repositório aberto): só a contagem, nunca o que a carteira do cliente tem
    console.log(`conferência: ${duvidas.length ? `${duvidas.length} ponto(s) para olhar (detalhes no Telegram)` : 'nada a apontar'}`);
    if (duvidas.length) {
      campos.i10Msg.stringValue += ` Conferir: ${duvidas.join('; ')}`;
      await telegram(`Carteira de ${nome}: a conferência achou ${duvidas.length === 1 ? 'um item' : 'itens'} pra olhar no painel:\n${duvidas.map((d) => `• ${d}`).join('\n')}`);
    }
    await salvar(campos);
    if (mud.length) {
      await avisarDonos(`Carteira de ${nome} atualizada`, mud.slice(0, 6).join('\n') + (mud.length > 6 ? `\ne mais ${mud.length - 6}` : ''));
      // o cliente também fica sabendo (o app põe as posições novas no Meus ativos dele)
      if (c.habilitada) await avisarContas([c.uid], 'Sua carteira foi atualizada', 'A InfoBolsa atualizou as posições da sua carteira. Toque pra ver em Meus ativos.', 'ativos');
    }
    console.log(`carteira ${c.uid.slice(0, 6)}…: ${mud.length ? `${mud.length} mudança(s)` : 'sem mudança'}${fora.length ? `, ${fora.length} fora do catálogo` : ''}`);
  } catch (e) {
    falhas++;
    console.log(`carteira ${c.uid.slice(0, 6)}…: não li o Investidor10 (${String(e.message).slice(0, 40).replace(/[0-9]{3,}/g, '…')})`);
    await salvar({ i10Msg: { stringValue: `Não consegui ler o Investidor10 hoje (${e.message}). Tento de novo na próxima rodada.` } }).catch(() => {});
  }
}
// falha de leitura deixa o passo vermelho: o aviso do Telegram (alerta.mjs) conta e avisa quando voltar
if (falhas) process.exit(1);
