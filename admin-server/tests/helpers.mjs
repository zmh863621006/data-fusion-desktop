export const password = 'Fixture-Password-2026!';
export const captchaFactory = () => ({ answer:'ABCDE', image:'data:image/png;base64,iVBORw0KGgo=' });
export async function loginCaptcha(base, body, token = '', headers = {}) {
  const challenge = await fetch(base+'/api/admin/captcha', {headers});
  const value = await challenge.json();
  if (challenge.status !== 200) throw new Error(`Fixture captcha failed: ${challenge.status}`);
  return { body:{...body,captchaId:value.id,captcha:'abcde'}, token:[token,challenge.headers.get('set-cookie')?.split(';')[0]].filter(Boolean).join('; ') };
}
