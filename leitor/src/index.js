// Leitor de notas de corretagem (Cloudflare Worker, plano grátis): o app manda o PDF da nota (padrão Sinacor, o da
// B3) e recebe na hora as compras e vendas com data, preço e taxas. Fluxo: confere o login do Firebase (token do
// usuário), conta o limite do dia (200 leituras por pessoa, no KV LIMITE), manda o PDF para o Claude Haiku e devolve
// { e_nota, notas }. A chave da Anthropic fica só aqui, como segredo do Worker (ANTHROPIC_NOTAS_KEY), nunca no app.
// Da nota só voltam as operações e os custos: nome, CPF e endereço do cliente não saem daqui nem ficam guardados.
//
// Por que fetch direto e não o SDK: o plano grátis do Worker dá ~10 ms de processador por pedido. Montar o pedido no
// SDK copiaria e varreria o PDF inteiro em JavaScript; aqui o arquivo passa direto, em fluxo, do app para a API, só
// com uma checagem rápida de que é base64 puro (sem aspas nem barra, que poderiam mexer no resto do pedido).

const PROJETO = 'infobolsa-investimentos';
const POR_DIA = 200; // leituras por dia (o app manda o PDF grande em partes de 15 páginas)
const MAX_BYTES = 8 * 1024 * 1024;
const JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const NUM = { type: 'number' };
const ESQUEMA = {
  type: 'object',
  properties: {
    e_nota: { type: 'boolean' },
    notas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'string' },
          d: { type: 'string' },
          compras: NUM,
          vendas: NUM,
          custos: NUM,
          irrf: NUM,
          liquido: NUM,
          dc: { type: 'string', enum: ['D', 'C'] },
          opc_compras: NUM,
          opc_vendas: NUM,
          outros: { type: 'boolean' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cv: { type: 'string', enum: ['C', 'V'] },
                esp: { type: 'string' },
                tk: { type: 'string' },
                deduzido: { type: 'boolean' },
                q: NUM,
                p: NUM,
                vl: NUM,
                dt: { type: 'boolean' },
                ex: { type: 'boolean' },
                opc: { type: 'string', enum: ['', 'call', 'put'] },
                serie: { type: 'string' },
                venc: { type: 'string' },
              },
              required: ['cv', 'esp', 'tk', 'deduzido', 'q', 'p', 'vl', 'dt', 'ex', 'opc', 'serie', 'venc'],
              additionalProperties: false,
            },
          },
        },
        required: ['n', 'd', 'compras', 'vendas', 'custos', 'irrf', 'liquido', 'dc', 'opc_compras', 'opc_vendas', 'outros', 'ops'],
        additionalProperties: false,
      },
    },
  },
  required: ['e_nota', 'notas'],
  additionalProperties: false,
};
const SISTEMA = 'Você lê notas de corretagem (nota de negociação) da bolsa brasileira, no padrão Sinacor da B3. Para cada nota do PDF, devolva:\n'
  + '- n: o Nr. nota. d: a Data pregão, em aaaa-mm-dd.\n'
  + '- compras e vendas: só os valores das linhas "Compras à vista" e "Vendas à vista" do Resumo dos Negócios.\n'
  + '- opc_compras e opc_vendas: os valores das linhas "Opções - compras" e "Opções - vendas" do Resumo dos Negócios (0 se não houver).\n'
  + '- custos: o total de custos e taxas da nota em reais (taxa de liquidação, taxa de registro, emolumentos, taxa de termo ou opções, taxa A.N.A., corretagem, ISS, impostos e outras), sem o I.R.R.F.\n'
  + '- irrf: o I.R.R.F. sobre operações (0 se não houver).\n'
  + '- liquido e dc: o valor do "Líquido para" (com a data) e a letra ao lado dele: D quando a pessoa paga, C quando recebe.\n'
  + '- ops: cada linha de "Negócios realizados" do mercado VISTA, FRACIONARIO, OPCAO DE COMPRA, OPCAO DE VENDA ou de exercício de opção (EXERC OPC COMPRA, EXERC OPC VENDA). cv: C ou V, como está na linha. esp: a especificação do título inteira, como está na nota (nome e classe, ex.: COSAN ON NM). '
  + 'tk: o ticker (ex.: HGRU11, PETR4, BOVA11, AAPL34; no fracionário, sem o F do final). Quando a nota trouxer só o nome (ex.: PETROBRAS PN N2), deduza o ticker pelo nome e pela classe (ON = 3, PN = 4, PNA = 5, PNB = 6, UNT = 11) e marque deduzido true. '
  + 'No exercício de opção, a linha é a compra ou a venda da ação pelo preço de exercício: tk é o ticker da ação (as 4 letras do código da opção mais o número da classe; ex.: PETRK319E PN = PETR4, CSANX59E ON = CSAN3, BRKMR820E PNA = BRKM5), deduzido true e ex true. Nas outras linhas, ex false. '
  + 'Na compra ou venda de opção (OPCAO DE COMPRA ou OPCAO DE VENDA), tk é o código da opção como está na nota (ex.: PETRK319, BBASL24), deduzido false. '
  + 'opc: call na OPCAO DE COMPRA e no EXERC OPC COMPRA, put na OPCAO DE VENDA e no EXERC OPC VENDA, vazio nas outras. serie: o código da opção nas linhas de opção e de exercício (ex.: PETRK319E), vazio nas outras. venc: o Prazo da linha de opção ou de exercício (mm/aa), vazio nas outras. '
  + 'q: a quantidade. p: o preço. vl: o valor da operação. dt: true quando a coluna Obs. tiver D (day trade).\n'
  + '- outros: true se a nota tiver operações a termo ou no mercado futuro. Essas não entram em ops.\n'
  + 'Uma nota pode ter várias folhas com o mesmo Nr. nota: junte tudo em uma só. Leia todas as linhas de todas as folhas, inclusive as repetidas: cada linha é uma operação, mesmo que seja igual à de cima. '
  + 'Antes de responder, confira se a soma dos valores das compras à vista bate com "Compras à vista", a das vendas com "Vendas à vista" e a das opções com "Opções - compras" e "Opções - vendas"; se não bater, procure a linha que faltou. Copie os números exatamente como estão na nota. '
  + 'Se o arquivo não for uma nota de corretagem, e_nota é false e notas vem vazia.';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ---------- login do Firebase: token JWT assinado pelo Google ----------
let chaves = null, chavesEm = 0;
async function chave(kid) {
  if (!chaves || Date.now() - chavesEm > 3600 * 1000 || !chaves[kid]) {
    const j = await (await fetch(JWKS)).json();
    chaves = {};
    for (const k of j.keys || []) chaves[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    chavesEm = Date.now();
  }
  return chaves[kid];
}
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function usuario(token) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const cab = JSON.parse(new TextDecoder().decode(b64url(h)));
  const dados = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (cab.alg !== 'RS256') return null;
  const k = await chave(cab.kid);
  if (!k || !(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, b64url(s), new TextEncoder().encode(`${h}.${p}`)))) return null;
  const agora = Date.now() / 1000;
  if (dados.aud !== PROJETO || dados.iss !== `https://securetoken.google.com/${PROJETO}` || !(dados.exp > agora) || !dados.sub) return null;
  return dados.sub;
}

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
// código da opção: as 4 do ativo (B3SA, PETR), a letra do mês (A a L call, M a X put), o número (2 a 4 algarismos: COSAN3 é a ação lida com o nome) e, na semanal, W e a
// semana (o E do fim, de opção europeia, sai: na linha de exercício a nota escreve PETRK319E para a mesma PETRK319)
const serieDe = (s) => (String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^[A-Z0-9]{3}[A-Z][A-X]\d{2,4}(W\d)?/) || [''])[0];
// a letra do mês diz se é call ou put (mais firme que a leitura)
const tipoDe = (serie) => (serie ? (serie[4] <= 'L' ? 'call' : 'put') : '');
// opcoes: o app novo pede as opções (?opcoes=1); o app antigo recebe as notas como antes, sem elas
const normalizar = (notas, opcoes) => (notas || [])
  .map((x) => ({
    n: String(x.n || '').replace(/\D/g, ''),
    d: /^\d{4}-\d{2}-\d{2}$/.test(x.d) ? x.d : '',
    compras: cent(x.compras), vendas: cent(x.vendas), custos: cent(x.custos), irrf: cent(x.irrf), liquido: cent(x.liquido), dc: x.dc === 'C' ? 'C' : 'D',
    ...(opcoes ? { opcCompras: cent(x.opc_compras), opcVendas: cent(x.opc_vendas) } : {}),
    outros: !!x.outros || (!opcoes && (x.ops || []).some((o) => o.opc && !o.ex)),
    ops: (x.ops || []).map((o) => {
      const serie = o.ex ? serieDe(o.serie) || serieDe((String(o.esp || '').toUpperCase().match(/[A-Z0-9]{4}[A-X]\d{2,4}(W\d)?E?\b/) || [''])[0]) : serieDe(o.tk) || (o.opc ? serieDe(o.serie) : '');
      const opc = tipoDe(serie);
      const venc = /^\d{2}\/\d{2}$/.test(o.venc) ? o.venc : '';
      return {
        cv: o.cv === 'V' ? 'V' : 'C',
        esp: String(o.esp || '').slice(0, 60),
        tk: opc && !o.ex ? serie : String(o.tk || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z0-9]{4}\d{1,2})F$/, '$1'),
        deduzido: opc && !o.ex ? false : !!o.deduzido,
        q: Math.round(Number(o.q) || 0), p: Number(o.p) || 0, vl: cent(o.vl), dt: !!o.dt, ex: !!o.ex,
        ...(opcoes && opc ? { opc, serie, venc } : {}),
      };
    }).filter((o) => o.q > 0 && (opcoes || !o.opc || o.ex)),
  }))
  .filter((x) => x.n && x.d);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/nota') return resposta(404, { erro: 'nao-encontrado' });
    const uid = await usuario((req.headers.get('Authorization') || '').replace(/^Bearer /, '')).catch(() => null);
    if (!uid) return resposta(401, { erro: 'login' });
    return lerNota(req, env, uid);
  },
};

// separado do login para dar para testar (teste.js, só no wrangler dev)
export async function lerNota(req, env, uid) {
  const tamanho = Number(req.headers.get('Content-Length'));
  if (!(tamanho > 100)) return resposta(400, { erro: 'vazio' });
  if (tamanho > MAX_BYTES) return resposta(413, { erro: 'grande' });

  // limite do dia (horário de Brasília)
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const chaveDia = `nota:${uid}:${dia}`;
  const usados = Number(await env.LIMITE.get(chaveDia)) || 0;
  if (usados >= POR_DIA) return resposta(429, { erro: 'limite' });
  await env.LIMITE.put(chaveDia, String(usados + 1), { expirationTtl: 2 * 86400 });

  // o pedido para a API: o PDF entra no meio, em fluxo
  const MARCA = '@@PDF@@';
  const modelo = JSON.stringify({
    model: 'claude-haiku-5-5',
    max_tokens: 32000,
    system: SISTEMA,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: MARCA } }, { type: 'text', text: 'Leia as notas deste PDF.' }] }],
  });
  const [antes, depois] = modelo.split(MARCA).map((t) => new TextEncoder().encode(t));
  const { readable, writable } = new FixedLengthStream(antes.length + tamanho + depois.length);
  let sujo = false;
  const dec = new TextDecoder();
  (async () => {
    const w = writable.getWriter();
    await w.write(antes);
    const r = req.body.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      const t = dec.decode(value, { stream: true });
      if (t.includes('"') || t.includes('\\')) { sujo = true; await w.abort('arquivo inválido'); return; }
      await w.write(value);
    }
    await w.write(depois);
    await w.close();
  })().catch(() => {});

  let api;
  try {
    api = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_NOTAS_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: readable,
    });
  } catch {
    return resposta(sujo ? 400 : 502, { erro: sujo ? 'arquivo' : 'ia' });
  }
  if (!api.ok) {
    const detalhe = (await api.text()).slice(0, 400);
    // PDF com senha ou páginas demais: a API recusa com 400
    const erro = api.status === 400 && /password|encrypt/i.test(detalhe) ? 'senha' : api.status === 400 && /page/i.test(detalhe) ? 'paginas' : api.status === 400 ? 'pdf' : 'ia';
    return resposta(502, { erro, status: api.status, detalhe: detalhe.slice(0, 300) });
  }
  const r = await api.json();
  if (r.stop_reason !== 'end_turn') return resposta(502, { erro: r.stop_reason === 'max_tokens' ? 'paginas' : 'ia', parou: r.stop_reason });
  let j;
  try { j = JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{}'); } catch { return resposta(502, { erro: 'ia' }); }
  const opcoes = new URL(req.url).searchParams.get('opcoes') === '1';
  return resposta(200, { e_nota: !!j.e_nota, notas: j.e_nota ? normalizar(j.notas, opcoes) : [], uso: { ent: r.usage?.input_tokens, sai: r.usage?.output_tokens } });
}
