// dump2.mjs —— 只读：按函数名整段打印 + 回调点上下文
import fs from 'node:fs'
const f = 'src/composables/ai/useAiAssistant.ts'
const src = fs.readFileSync(f, 'utf8')
const lines = src.split('\n')

function skipString(s, i, q){ i++; while(i<s.length){ const c=s[i]; if(c==='\\'){i+=2;continue} if(c===q)return i+1; i++ } return i }
function skipPair(s, i, open, close){ let d=0
  while(i<s.length){ const c=s[i]
    if(c==='/'&&s[i+1]==='/'){ const n=s.indexOf('\n',i); i=n<0?s.length:n; continue }
    if(c==='/'&&s[i+1]==='*'){ const e=s.indexOf('*/',i+2); i=e<0?s.length:e+2; continue }
    if(c==='"'||c==="'"){ i=skipString(s,i,c); continue }
    if(c==='`'){ i=skipTpl(s,i); continue }
    if(c===open){ d++; i++; continue }
    if(c===close){ d--; i++; if(d===0)return i; continue }
    i++ } return i }
function skipTpl(s, i){ i++; while(i<s.length){ const c=s[i]; if(c==='\\'){i+=2;continue} if(c==='`')return i+1; if(c==='$'&&s[i+1]==='{'){ i=skipPair(s,i+1,'{','}'); continue } i++ } return i }
const lineOf = (idx) => src.slice(0, idx).split('\n').length

function bodyOf(name){
  const re = new RegExp(`(^|\\n)([\\t ]*)(?:export\\s+)?(?:(?:const|let|var)\\s+|(?:async\\s+)?function\\s+)${name}\\b`)
  const m = re.exec(src); if(!m) return null
  const start = m[1]==='\n' ? m.index+1 : m.index
  const paren = src.indexOf('(', m.index+m[0].length)
  const afterParams = skipPair(src, paren, '(', ')')
  const brace = src.indexOf('{', afterParams)
  const end = skipPair(src, brace, '{', '}')
  return { startLine: lineOf(start), endLine: lineOf(end) }
}
function printSpan(label, s){
  if(!s){ console.log(`\n##### ${label}: NOT FOUND #####`); return }
  console.log(`\n##### ${label}  (lines ${s.startLine}-${s.endLine}) #####`)
  for(let i=s.startLine;i<=s.endLine && i<=lines.length;i++) console.log(String(i).padStart(5)+'  '+lines[i-1])
}
for(const n of ['updateLiveThreadFromSidecarEvents','finalizeSidecarTurn']) printSpan(n, bodyOf(n))

function ctx(reSrc){
  const re = new RegExp(reSrc)
  lines.forEach((ln,i)=>{ if(re.test(ln)){ const a=Math.max(0,i-9), b=Math.min(lines.length-1,i+3)
    console.log(`\n----- /${reSrc}/ @ line ${i+1} -----`)
    for(let k=a;k<=b;k++) console.log(String(k+1).padStart(5)+'  '+lines[k]) } })
}
ctx('applySidecarLiveEventsToAgentMessage\\(')
ctx('updateLiveThreadFromSidecarEvents\\(')