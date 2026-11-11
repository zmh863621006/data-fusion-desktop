import { createHmac,createHash } from 'node:crypto';

const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
export function ossV4Signature({secret,region,timestamp,method,resource,query='',headers}) {
  const canonicalHeaders=Object.entries(headers).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key.toLowerCase()}:${value.trim()}\n`).join('');
  const canonicalQuery=[...new URLSearchParams(query)].map(([key,value])=>[encode(key),encode(value)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([key,value])=>value?`${key}=${value}`:key).join('&');
  const canonical=`${method}\n${resource}\n${canonicalQuery}\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`;
  const scope=`${timestamp.slice(0,8)}/${region}/oss/aliyun_v4_request`;
  const toSign=`OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  const key=hmac(hmac(hmac(hmac('aliyun_v4'+secret,timestamp.slice(0,8)),region),'oss'),'aliyun_v4_request');
  return hmac(key,toSign).toString('hex');
}

const decode = text => text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const tag = (xml,name) => decode(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '');
export function createOssEstablishmentSource(config, fetcher = fetch) {
  const endpoint = config.endpoint?.replace(/^https:\/\//,'').replace(/\/$/,'');
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint ?? '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '')) throw Error('OSS Endpoint 或 Bucket 无效');
  if (!config.accessKeyId || !config.accessKeySecret || !/^[a-zA-Z0-9_/-]+$/.test(config.prefix ?? '') || config.prefix.includes('..')) throw Error('OSS 读取凭据或目录无效');
  const prefix = config.prefix.endsWith('/') ? config.prefix : config.prefix + '/';
  async function get(key, query = '') {
    const timestamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const region=endpoint.slice(4,-'.aliyuncs.com'.length).replace(/-internal$/,'');
    const headers = { 'x-oss-date':timestamp,'x-oss-content-sha256':'UNSIGNED-PAYLOAD' };
    if (config.securityToken) headers['x-oss-security-token'] = config.securityToken;
    const signature=ossV4Signature({secret:config.accessKeySecret,region,timestamp,method:'GET',resource:`/${config.bucket}/${key}`,query:query.replace(/^\?/,''),headers});
    headers.Authorization=`OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${timestamp.slice(0,8)}/${region}/oss/aliyun_v4_request,Signature=${signature}`;
    const response = await fetcher(`https://${config.bucket}.${endpoint}/${key}${query}`, { headers, redirect: 'error', signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw Error(`OSS 读取失败，HTTP ${response.status}`);
    return response;
  }
  return {
    async list() {
      const objects = []; let token = ''; const tokens = new Set();
      do {
        const query = new URLSearchParams({ 'list-type':'2', prefix, 'max-keys':'1000' });
        if (token) query.set('continuation-token',token);
        const response = await get('', '?' + query); const xml = await response.text();
        if (!xml.includes('<ListBucketResult')) throw Error('OSS 列表格式无效');
        for (const item of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(item[1],'Key'), size = Number(tag(item[1],'Size'));
          if (key.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}_[a-f0-9]{64}\.xlsx$/.test(key.slice(prefix.length))) {
            if (!Number.isSafeInteger(size) || size > 64*1024*1024) throw Error('OSS 文件超过64MiB限制');
            objects.push({key,size});
          }
        }
        const truncated = tag(xml,'IsTruncated');
        token = truncated === 'true' ? tag(xml,'NextContinuationToken') : '';
        if (truncated === 'true' && (!token || tokens.has(token))) throw Error('OSS 列表分页异常');
        tokens.add(token);
      } while (token);
      return objects.sort((a,b)=>a.key.localeCompare(b.key,'en'));
    },
    async download(key) {
      if (!key.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}_[a-f0-9]{64}\.xlsx$/.test(key.slice(prefix.length))) throw Error('OSS 对象路径不属于设立采集目录');
      const response = await get(key); const declared = Number(response.headers.get('content-length'));
      if (declared > 64*1024*1024) throw Error('OSS 文件超过64MiB限制');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 64*1024*1024) throw Error('OSS 文件超过64MiB限制'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    },
  };
}
