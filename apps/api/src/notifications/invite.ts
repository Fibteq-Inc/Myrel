import { sendEmail } from "./channels";

export type InviteEmail = {
  to: string;
  projectName: string;
  inviterName: string;
  /** Where the invitee opens it: the invitations page, or sign-up when they have no account yet. */
  link: string;
};

/** The invitation email, in English and Turkish (the invitee's language is not known). */
export async function sendInviteEmail(env: Env, input: InviteEmail): Promise<void> {
  const { to, projectName, inviterName, link } = input;
  const text = [
    `${inviterName} invited you to the project "${projectName}" on Myrel.`,
    `Open it here, signing in or creating an account with this email address (${to}):`,
    link,
    `${inviterName} sizi Myrel'de "${projectName}" projesine davet etti. Bu e-posta adresiyle giriş yapın ya da hesap açın.`,
    "If you did not expect this, ignore this email.",
  ].join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#18181b">
<h2 style="font-size:18px;margin:0 0 12px">${esc(inviterName)} invited you to ${esc(projectName)}</h2>
<p style="line-height:1.5">Sign in or create an account with <b>${esc(to)}</b> to join the project on Myrel.<br>${esc(inviterName)} sizi Myrel'de <b>${esc(projectName)}</b> projesine davet etti. Bu e-posta adresiyle giriş yapın ya da hesap açın.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#5b6cff;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Open invitation · Daveti aç</a></p>
<p style="color:#71717a;font-size:13px">If you did not expect this, ignore this email.</p>
</div>`;
  await sendEmail(env, { to, subject: `${inviterName} invited you to ${projectName} on Myrel`, text, html });
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
