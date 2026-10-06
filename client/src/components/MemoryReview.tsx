import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Drawer, Input, Select, Space, Spin, Typography, message } from 'antd'
import api from '../api'

const { TextArea } = Input
const kinds: Record<string,string> = { situation:'角色处境', relation:'人物关系', item:'物品', knowledge:'知情范围' }
const predicates: Record<string,string[]> = { situation:['位置','身体状况','当前目标'], relation:['关系'], item:['持有人','位置','状态'], knowledge:['知情'] }
interface Fact { id?: string; kind: string; subject: string; predicate: string; value: string }
interface Hook { id?: string; content: string }
interface Memory { summary: string; facts: Fact[]; hooks: Hook[]; handoff: Record<string,string> }
interface Review {
  review_id: string; chapter_number: number; memory: Memory; previous: string; evidence: string;
  issues: {problem:string;quote:string;evidence:string}[]; notices: string[];
}

export default function MemoryReview({ novelId, chapterNum, canSuggest, beforeAction, onClose, onConfirmed, onNext }: {
  novelId: string; chapterNum: number; canSuggest: boolean; beforeAction: () => Promise<void>;
  onClose: () => void; onConfirmed: () => Promise<unknown>; onNext?: () => void;
}) {
  const [review,setReview] = useState<Review | null>(null)
  const [busy,setBusy] = useState('')
  const [error,setError] = useState('')
  const [dirty,setDirty] = useState(false)
  const [checked,setChecked] = useState(false)
  const [done,setDone] = useState(false)
  const [notice,setNotice] = useState('')
  const url = `/novels/${novelId}/chapters/${chapterNum}/memory-review`
  const load = async () => {
    setBusy('load'); setError('')
    try {
      await beforeAction()
      const {data} = await api.post(url)
      setReview(data); setDirty(false); setChecked(false); setDone(false)
    } catch(e: any) { setError(e.response?.data?.message || e.message) }
    finally { setBusy('') }
  }
  useEffect(() => { void load() }, [novelId,chapterNum])
  const edit = (patch: Partial<Memory>) => {
    setReview(r => r ? {...r,memory:{...r.memory,...patch}} : r)
    setDirty(true); setChecked(false)
  }
  const save = async (confirm: boolean) => {
    if (!review) return
    setBusy(confirm?'confirm':'save'); setError('')
    try {
      await beforeAction()
      const {data} = await api.put(url,{review_id:review.review_id,memory:review.memory,confirm})
      if (confirm) { setDone(true); setNotice(data.warning || ''); await onConfirmed() }
      else { setReview(data); setDirty(false); message.success('核对草稿已保存') }
    } catch(e: any) { setError(e.response?.data?.message || e.message) }
    finally { setBusy('') }
  }
  const suggest = async () => {
    if (!review) return
    setBusy('suggest'); setError('')
    try {
      await beforeAction()
      const {data} = await api.post(url,{suggest:true,review_id:review.review_id})
      setReview(data); setDirty(false); setChecked(false)
    } catch(e: any) { setError(e.response?.data?.message || e.message) }
    finally { setBusy('') }
  }
  const factEdit = (i: number, patch: Partial<Fact>) => review && edit({facts:review.memory.facts.map((f,j)=>i===j?{...f,...patch}:f)})
  return <Drawer title={`第 ${chapterNum} 章 · 核对记忆并定稿`} open width="min(920px, 100vw)" onClose={() => {
    if (busy) return
    if (dirty && !done) { setError('还有未保存的修改，请先保存核对草稿，再关闭。'); return }
    onClose()
  }} maskClosable={!busy && !dirty} extra={!done && <Space>
    <Button disabled={!!busy || !review} onClick={() => void save(false)}>保存核对草稿</Button>
    <Button type="primary" disabled={!checked || !!busy || !review} loading={busy==='confirm'} onClick={() => void save(true)}>确认记忆并定稿</Button>
  </Space>}>
    {error && <Alert type="error" showIcon message={error} style={{marginBottom:16}} action={<Button size="small" disabled={!!busy} onClick={() => void load()}>重新载入</Button>} />}
    {done ? <Space direction="vertical" style={{width:'100%'}}>
      <Alert type="success" showIcon message="人工确认已保存，下一章可以使用这份记忆。" description={notice} />
      <Space><Button onClick={onClose}>完成</Button>{onNext && <Button type="primary" onClick={onNext}>核对下一章</Button>}</Space>
    </Space> : <Spin spinning={!!busy} tip={busy==='suggest'?'正在整理候选记忆和审校意见…':'处理中…'}>
      <Space direction="vertical" size="middle" style={{width:'100%'}}>
        <Alert type="info" showIcon message="以你的核对结果为准" description="核对本章摘要、当前事实和未解伏笔。AI 意见仅供参考；确认后才写入下一章上下文。修正旧章记忆会使后续章节待重新核对，正文保留。" />
        <Space wrap>
          <Button disabled={!canSuggest || !review || !!busy || dirty} loading={busy==='suggest'} onClick={() => void suggest()}>AI 整理记忆与审校</Button>
          {dirty && <Button disabled={!!busy} onClick={()=>void load()}>撤销未保存修改</Button>}
          <Typography.Text type="secondary">可直接手工填写；AI 会替换当前候选记忆，修改后请先保存。</Typography.Text>
        </Space>
        {review?.notices.map((n,i) => <Alert key={i} type="warning" showIcon message={n} />)}
        {!!review?.issues.length && <Collapse items={[{key:'issues',label:`审校参考意见（${review.issues.length} 条，可由作者判断为误报）`,children:review.issues.map((issue,i)=><div key={i} style={{marginBottom:16}}>
          <strong>{i+1}. {issue.problem}</strong><p>正文：{issue.quote}</p><p>依据：{issue.evidence}</p>
        </div>)}]} />}
        {review && <>
          <Collapse items={[
            {key:'previous',label:'查看进入本章时的记忆',children:<pre style={{whiteSpace:'pre-wrap'}}>{review.previous}</pre>},
            ...(review.evidence ? [{key:'evidence',label:'查看历史原文依据',children:<pre style={{whiteSpace:'pre-wrap'}}>{review.evidence}</pre>}] : []),
          ]} />
          <label><strong>本章摘要</strong><TextArea aria-label="本章摘要" rows={4} maxLength={2000} showCount value={review.memory.summary} onChange={e=>edit({summary:e.target.value})} placeholder="本章实际发生了什么，结果如何。把重要数量、原话和已揭晓的答案写清楚。" /></label>
          <div><Typography.Title level={5}>当前事实</Typography.Title>
            <Typography.Paragraph type="secondary">只留当前有效的事实。物品持有人写人物，知情范围写角色；已过时的条目可删除。</Typography.Paragraph>
            {review.memory.facts.map((f,i)=><div key={i} style={{padding:12,marginBottom:8,border:'1px solid #eee',borderRadius:6}}>
              <Space wrap style={{marginBottom:8}}>
                <Select aria-label={`事实${i+1}类别`} value={f.kind} style={{width:120}} options={Object.entries(kinds).map(([value,label])=>({value,label}))} onChange={kind=>factEdit(i,{kind,predicate:predicates[kind][0]})} />
                <Input aria-label={`事实${i+1}主体`} value={f.subject} style={{width:240}} placeholder="人物、物品或信息" onChange={e=>factEdit(i,{subject:e.target.value})} />
                <Select aria-label={`事实${i+1}属性`} value={f.predicate} style={{width:130}} options={(predicates[f.kind] || []).map(value=>({value,label:value}))} onChange={predicate=>factEdit(i,{predicate})} />
                <Button danger type="text" onClick={()=>edit({facts:review.memory.facts.filter((_,j)=>j!==i)})}>删除事实</Button>
              </Space>
              <TextArea aria-label={`事实${i+1}当前值`} rows={2} maxLength={300} showCount value={f.value} onChange={e=>factEdit(i,{value:e.target.value})} />
            </div>)}
            <Button onClick={()=>edit({facts:[...review.memory.facts,{kind:'item',subject:'',predicate:'持有人',value:''}]})}>添加事实</Button>
          </div>
          <div><Typography.Title level={5}>仍未解答的伏笔</Typography.Title>
            <Typography.Paragraph type="secondary">已揭晓的点击关闭；部分揭晓时只保留尚未解答的问题。</Typography.Paragraph>
            {review.memory.hooks.map((h,i)=><div key={i} style={{display:'flex',gap:8,marginBottom:8}}>
              <TextArea aria-label={`伏笔${i+1}`} rows={2} value={h.content} maxLength={2000} onChange={e=>edit({hooks:review.memory.hooks.map((v,j)=>j===i?{...v,content:e.target.value}:v)})} />
              <Button onClick={()=>edit({hooks:review.memory.hooks.filter((_,j)=>j!==i)})}>关闭伏笔</Button>
            </div>)}
            <Button onClick={()=>edit({hooks:[...review.memory.hooks,{content:''}]})}>添加未解问题</Button>
          </div>
          <div><Typography.Title level={5}>下一章衔接</Typography.Title>
            {Object.entries({scene:'结尾场景（必填）',doing:'正在做 / 刚决定',pending:'悬而未决',mood:'当前情绪',lastLines:'正文最后一段'}).map(([key,label])=><label key={key} style={{display:'block',marginBottom:8}}>{label}<TextArea aria-label={label} rows={key==='lastLines'?3:2} value={review.memory.handoff[key] || ''} maxLength={3000} onChange={e=>edit({handoff:{...review.memory.handoff,[key]:e.target.value}})} /></label>)}
          </div>
          <Checkbox checked={checked} onChange={e=>setChecked(e.target.checked)}>我已核对正文、记忆与审校意见，以上内容作为下一章的依据。</Checkbox>
        </>}
      </Space>
    </Spin>}
  </Drawer>
}
