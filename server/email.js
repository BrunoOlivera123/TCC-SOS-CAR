// =================================================================
// Envio de e-mail da recuperação de senha (código de 6 dígitos)
// Gmail + Nodemailer
// =================================================================

const nodemailer = require('nodemailer');

// Escapa caracteres especiais para evitar problemas no HTML
function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Verifica se o SMTP está configurado
function smtpConfigurado() {
  return Boolean(
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

// Transportador do Gmail
let transportador;

// Cria o transportador do Nodemailer na primeira vez e o reutiliza depois (a
// conexão com o servidor de e-mail é reaproveitada entre os envios).
function obterTransportador() {
  if (!transportador) {
    transportador = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  return transportador;
}

// Só para desenvolvimento local: sem SMTP configurado não há como o código
// chegar ao usuário, então (e SOMENTE se MOSTRAR_CODIGO_REDEFINICAO_NO_CONSOLE=1
// — ou o nome antigo MOSTRAR_LINK_REDEFINICAO_NO_CONSOLE=1 — e o NODE_ENV não
// for "production") o código é impresso no terminal do servidor. Por padrão o
// código NUNCA vai para o log: quem lê logs poderia redefinir qualquer conta.
function logDeCodigoPermitido() {
  const flag =
    process.env.MOSTRAR_CODIGO_REDEFINICAO_NO_CONSOLE === '1' ||
    process.env.MOSTRAR_LINK_REDEFINICAO_NO_CONSOLE === '1';
  return flag && process.env.NODE_ENV !== 'production';
}

// Mascara o e-mail nos logs (ma***@dominio.com).
function mascararEmail(email) {
  const [local = '', dominio = ''] = String(email).split('@');
  return `${local.slice(0, 2)}***@${dominio}`;
}

// Monta o e-mail (texto simples + HTML) com o código de verificação.
function montarEmailCodigo({ nome, codigo, minutosValidade }) {
  const primeiroNome = String(nome || '').trim();
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}.` : 'Olá.';

  const text =
    `${saudacao}\n\n` +
    `Recebemos uma solicitação para redefinir a senha da sua conta SOS Car.\n\n` +
    `Seu código de verificação é:\n\n` +
    `${codigo}\n\n` +
    `Este código é válido por ${minutosValidade} minutos.\n\n` +
    `Se você não solicitou a redefinição de senha, ignore este email.`;

  const digitos = String(codigo)
    .split('')
    .map(
      (d) =>
        `<span style="display:inline-block;width:42px;height:54px;line-height:54px;margin:0 3px;` +
        `background:#fff8d9;border:1px solid #fbca29;border-radius:10px;` +
        `font-size:28px;font-weight:700;color:#0f2747;text-align:center;">${escaparHtml(d)}</span>`
    )
    .join('');

  const html =
    `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f4f6fa;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:24px 12px;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="max-width:480px;background:#ffffff;border-radius:14px;border:1px solid #dce4ee;` +
    `font-family:Arial,Helvetica,sans-serif;color:#0f2747;">` +
    `<tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:700;">SOS <span style="color:#d9a400;">Car</span></td></tr>` +
    `<tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.5;">` +
    `<p style="margin:0 0 12px;">${escaparHtml(saudacao)}</p>` +
    `<p style="margin:0 0 12px;">Recebemos uma solicitação para redefinir a senha da sua conta SOS Car.</p>` +
    `<p style="margin:0 0 12px;">Seu código de verificação é:</p>` +
    `</td></tr>` +
    `<tr><td align="center" style="padding:8px 28px 16px;">${digitos}</td></tr>` +
    `<tr><td style="padding:0 28px 8px;font-size:14px;line-height:1.5;color:#58708d;">` +
    `<p style="margin:0 0 12px;">Este código é válido por ${minutosValidade} minutos.</p>` +
    `<p style="margin:0 0 12px;">Se você não solicitou a redefinição de senha, ignore este email.</p>` +
    `</td></tr>` +
    `<tr><td style="padding:12px 28px 24px;font-size:12px;color:#94a3b8;">` +
    `Por segurança, nunca compartilhe este código com ninguém.` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { text, html };
}

// Envia o código de redefinição por e-mail.
// NÃO devolve o código: quem chama (a rota) nunca deve poder repassá-lo ao
// navegador. Devolve { enviado, modoDev }: "modoDev" = SMTP ausente e código
// mostrado no console (só desenvolvimento, só com a variável explícita).
async function enviarEmailCodigoRedefinicao({ paraEmail, nome, codigo, minutosValidade = 10 }) {
  if (!smtpConfigurado()) {
    if (logDeCodigoPermitido()) {
      console.warn(
        `[e-mail] SMTP não configurado (modo de desenvolvimento).\n` +
          `Código de redefinição para ${mascararEmail(paraEmail)}: ${codigo}`
      );
      return { enviado: false, modoDev: true };
    }
    console.warn(
      `[e-mail] SMTP não configurado: o código de redefinição para ${mascararEmail(paraEmail)} NÃO foi enviado. ` +
        `Configure SMTP_USER/SMTP_PASS (ou, só em desenvolvimento, MOSTRAR_CODIGO_REDEFINICAO_NO_CONSOLE=1).`
    );
    return { enviado: false, modoDev: false };
  }

  try {
    const { text, html } = montarEmailCodigo({ nome, codigo, minutosValidade });
    await obterTransportador().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: paraEmail,
      subject: 'Seu código para redefinir a senha — SOS Car',
      text,
      html
    });
    console.log(`[e-mail] Código de redefinição enviado para ${mascararEmail(paraEmail)}`);
    return { enviado: true, modoDev: false };
  } catch (erro) {
    // Só o motivo genérico: a mensagem do nodemailer pode citar o destinatário
    // ou trechos do envio, e o código nunca é registrado.
    console.warn(`[e-mail] Falha ao enviar para ${mascararEmail(paraEmail)}:`, erro && erro.code ? erro.code : 'erro de envio');
    return { enviado: false, modoDev: false };
  }
}

module.exports = {
  enviarEmailCodigoRedefinicao,
  montarEmailCodigo
};
