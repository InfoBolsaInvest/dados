// Aviso no Telegram quando alguma parte do robô falha (último passo de toda rodada).
// Avisa quando a falha começa, lembra a cada 3 horas se continuar e avisa quando volta a funcionar.
// Também avisa quando o robô ficou parado no horário do pregão (o despertador ou o agendamento atrasou ou pulou).
// O que já foi avisado fica em .alerta/estado.json, guardado no cache do Actions entre as rodadas.
// TELEGRAM_TOKEN e TELEGRAM_CHAT são segredos do repositório; sem eles o passo só escreve no log.
// O bot é o mesmo das notícias e da carteira dos clientes: aqui só se manda mensagem, nunca se lê
// (getUpdates brigaria com o programa que já recebe as mensagens dele).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT;
const LINK = process.env.RUN_URL || '';
const MODO = process.env.MODO || ''; // teste = mensagem de teste; falha = finge que os vídeos falharam
const ARQ = '.alerta/estado.json';
const LEMBRAR = 3 * 3600 * 1000;
const PARADO = 45; // minutos sem rodar no pregão que já merecem aviso

const NOMES = {
  cot: 'Cotações (brapi)',
  b3: 'Conferência com a B3',
  hist: 'Ibovespa, dólar e histórico',
  yahoo: 'Bolsas de fora e 5 anos (Yahoo)',
  nomes: 'Nomes de ativos novos',
  fund: 'Proventos e valor patrimonial',
  agenda: 'Agenda',
  rf: 'Renda fixa',
  videos: 'Vídeos do canal',
  noticias: 'Notícias',
  google: 'Entrada no Google (avisos no celular)',
  repor: 'Reposição dos arquivos',
  avisos: 'Avisos no celular',
  i10: 'Carteiras dos clientes (Investidor10)',
  publicar: 'Publicação do site',
};

const agora = new Date();
const brt = (d) => new Date(d.getTime() - 3 * 3600 * 1000);
const hora = (d) => brt(d).toISOString().slice(11, 16);
const dia = (d) => brt(d).toISOString().slice(0, 10);

async function enviar(chat, texto) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

if (!TOKEN || !CHAT) { console.log('Telegram não configurado (falta TELEGRAM_TOKEN ou TELEGRAM_CHAT): sem aviso'); process.exit(0); }

let estado = { falhas: {}, ultima: null };
try { estado = JSON.parse(readFileSync(ARQ, 'utf8')); } catch {}

const passos = JSON.parse(process.env.PASSOS || '{}');
if (MODO === 'falha') passos.videos = 'failure';

const novas = [], seguem = [], voltaram = [];
for (const [id, nome] of Object.entries(NOMES)) {
  const r = passos[id]; // success, failure, skipped ou vazio (não chegou no passo)
  const antes = estado.falhas[id];
  if (r === 'failure') {
    if (!antes) { novas.push(nome); estado.falhas[id] = { desde: agora.toISOString(), avisado: agora.toISOString() }; }
    else if (agora - new Date(antes.avisado) >= LEMBRAR) { seguem.push(`${nome} (desde ${hora(new Date(antes.desde))})`); antes.avisado = agora.toISOString(); }
  } else if (r === 'success' && antes) {
    voltaram.push(nome); delete estado.falhas[id];
  } // pulado (skipped) não muda nada: o passo nem rodou
}
// falhou fora dos passos conhecidos (ex.: antes de buscar as cotações)
if (process.env.JOB_STATUS === 'failure' && !Object.values(passos).includes('failure')) novas.push('Outro passo do robô');

// robô parado: compara com a última rodada que chegou até aqui
const parado = [];
if (estado.ultima) {
  const u = new Date(estado.ultima);
  const min = Math.round((agora - u) / 60000);
  const minBrt = brt(agora).getUTCHours() * 60 + brt(agora).getUTCMinutes();
  if (dia(u) === dia(agora) && min >= PARADO) parado.push(`O robô ficou ${min} minutos sem rodar (das ${hora(u)} às ${hora(agora)}).`);
  else if (dia(u) !== dia(agora) && minBrt >= 10 * 60 + PARADO) parado.push(`A primeira rodada de hoje só aconteceu às ${hora(agora)} (o certo é 10:00).`);
}
if (['schedule', 'relogio'].includes(process.env.EVENTO)) estado.ultima = agora.toISOString(); // rodada na mão não conta

const partes = [];
if (MODO === 'teste') partes.push('Teste: o aviso de falhas do robô do app está ligado.');
if (novas.length) partes.push(`Parou de funcionar:\n${novas.map((n) => `• ${n}`).join('\n')}`);
if (seguem.length) partes.push(`Continua com problema:\n${seguem.map((n) => `• ${n}`).join('\n')}`);
if (voltaram.length) partes.push(`Voltou a funcionar:\n${voltaram.map((n) => `• ${n}`).join('\n')}`);
partes.push(...parado);

if (partes.length) {
  if (novas.length || seguem.length) partes.push('O app continua com os últimos dados que deram certo.');
  if (LINK && (novas.length || seguem.length)) partes.push(`Detalhes: ${LINK}`);
  try { await enviar(CHAT, `📱 App InfoBolsa, robô de dados (${hora(agora)})\n\n${partes.join('\n\n')}`); console.log('aviso mandado no Telegram'); }
  catch (e) { console.log(`não consegui mandar no Telegram: ${e.message}`); process.exit(0); } // não grava: tenta de novo na próxima
} else console.log('tudo certo: nada a avisar');

mkdirSync('.alerta', { recursive: true });
writeFileSync(ARQ, JSON.stringify(estado));
