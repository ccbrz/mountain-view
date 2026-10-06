import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Col, Collapse, Drawer, Empty, Input, Modal, Row, Space, Spin, Tabs, Typography, message } from 'antd'
import api from '../api'

type Candidate = { review_id: string; outline: string; suggestions: {text:string;reason:string}[]; selected:number[]; notes:string[]; stale:boolean }
type Version = { id:number; note:string; created_at:string; created_by:string }
type Review = { original:string; outline_revision:number; review:Candidate|null; versions:Version[] }

export default function OutlineReview({novelId,chapterNum,initialTab,beforeAction,onApplied,onClose}: {
  novelId:string; chapterNum:number; initialTab:'review'|'versions'; beforeAction:()=>Promise<void>;
  onApplied:(outline:string,revision:number)=>void; onClose:()=>void;
}) {
  const [data,setData]=useState<Review|null>(null)
  const [tab,setTab]=useState<string>(initialTab)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState('')
  const [dirty,setDirty]=useState(false)
  const [compress,setCompress]=useState(false)
  const [version,setVersion]=useState<(Version & {outline:string})|null>(null)
  const url=`/novels/${novelId}/chapters/${chapterNum}`
  const fail=(e:any)=>setError(e.response?.data?.message||e.message)
  const load=async()=>{
    setBusy('load');setError('')
    try {await beforeAction();const {data}=await api.get(`${url}/outline-review`);setData(data);setDirty(false)}
    catch(e){fail(e)}finally{setBusy('')}
  }
  useEffect(()=>{void load()},[novelId,chapterNum])
  const update=(patch:Partial<Candidate>)=>{setData(d=>d?.review?{...d,review:{...d.review,...patch}}:d);setDirty(true)}
  const generate=async()=>{
    if(!data)return
    setBusy('generate');setError('')
    try {
      await beforeAction()
      const r=await api.post(`/novels/${novelId}/polish/outline/${chapterNum}`,{outline_revision:data.outline_revision,review_id:data.review?.review_id,compress_dialogue:compress})
      setData({...data,review:r.data});setDirty(false)
    }catch(e){fail(e)}finally{setBusy('')}
  }
  const save=async(confirm=false):Promise<boolean>=>{
    if(!data?.review)return true
    setBusy(confirm?'adopt':'save');setError('')
    try {
      await beforeAction()
      const r=await api.put(`${url}/outline-review`,{review_id:data.review.review_id,outline:data.review.outline,selected:data.review.selected,confirm})
      setDirty(false)
      if(confirm){onApplied(r.data.outline,r.data.outline_revision);message.success('已采纳台本，原稿已保留在台本版本中');onClose()}
      else {setData({...data,review:r.data});message.success('候选已保存，原台本未变')}
      return true
    }catch(e){fail(e);return false}finally{setBusy('')}
  }
  const close=async()=>{if(busy)return;if(!dirty||await save())onClose()}
  const reload=()=>{
    if(dirty) Modal.confirm({title:'重新载入会放弃窗口内未保存的候选修改',okText:'放弃修改并载入',cancelText:'继续编辑',onOk:load})
    else void load()
  }
  const restore=async()=>{
    if(!version||!data)return
    setBusy('restore');setError('')
    try {
      await beforeAction()
      const r=await api.post(`${url}/outline-versions/${version.id}/restore`,{outline_revision:data.outline_revision})
      onApplied(r.data.outline,r.data.outline_revision);message.success('已恢复台本，恢复前的版本也已保留');onClose()
    }catch(e){fail(e)}finally{setBusy('')}
  }
  const candidate=data?.review
  return <Drawer open width="min(1120px, 100vw)" title={`第 ${chapterNum} 章 · 台本整理`} onClose={()=>void close()} maskClosable={!busy} extra={<Button disabled={!!busy} onClick={()=>void close()}>返回章节</Button>}>
    {error&&<Alert type="error" showIcon message={error} action={<Button size="small" disabled={!!busy} onClick={reload}>重新载入</Button>} style={{marginBottom:16}}/>}
    <Spin spinning={!!busy} tip={busy==='generate'?'正在整理候选，原台本保持不变…':'处理中…'}>
      <Tabs activeKey={tab} onChange={setTab} items={[
        {key:'review',label:'整理候选',children:<Space direction="vertical" size="middle" style={{width:'100%'}}>
          <Alert type={candidate?.stale?'warning':'info'} showIcon message={candidate?.stale?'原台本或上下文已变化，此候选不能直接采纳。请重新载入并重新整理。':'先核对候选，再采纳为当前台本。原稿会自动保存为可恢复的版本。'}/>
          <Space wrap>
            <Button disabled={!!busy||!data?.original.trim()||dirty} loading={busy==='generate'} onClick={()=>candidate?Modal.confirm({title:'重新整理会替换已保存的候选',content:'原台本不变。',okText:'重新整理',cancelText:'继续核对',onOk:generate}):void generate()}>{candidate?'重新整理':'生成整理候选'}</Button>
            <Checkbox checked={compress} disabled={!!busy} onChange={e=>setCompress(e.target.checked)}>允许压缩非关键对白（默认保留全部对白）</Checkbox>
          </Space>
          {data&&<Row gutter={[16,16]}>
            <Col xs={24} md={12}><Typography.Title level={5}>原台本</Typography.Title><div style={{whiteSpace:'pre-wrap',padding:16,background:'var(--ant-color-fill-quaternary, rgba(127,127,127,.05))',borderRadius:6}}>{data.original||'尚未填写台本'}</div></Col>
            <Col xs={24} md={12}><Typography.Title level={5}>整理候选 <Typography.Text type="secondary" style={{fontSize:12}}>可直接编辑</Typography.Text></Typography.Title>
              {candidate?<Input.TextArea aria-label="整理候选" autoSize={{minRows:14}} maxLength={50000} value={candidate.outline} disabled={!!busy} onChange={e=>update({outline:e.target.value})}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成后在这里核对，原台本不会被覆盖"/>}
            </Col>
          </Row>}
          {candidate&&<>
            {!!candidate.suggestions.length&&<div><Typography.Title level={5}>AI 补充建议 <Typography.Text type="secondary" style={{fontSize:12}}>默认不写入台本</Typography.Text></Typography.Title>
              {candidate.suggestions.map((s,i)=><div key={i} style={{marginBottom:12}}><Checkbox disabled={!!busy||(!candidate.selected.includes(i)&&candidate.outline.includes(s.text))} checked={candidate.selected.includes(i)} onChange={e=>{
                const checked=e.target.checked
                const outline=checked ? (candidate.outline.includes(s.text)?candidate.outline:`${candidate.outline}\n${s.text}`) : candidate.outline.split('\n').filter(line=>line!==s.text).join('\n')
                update({outline,selected:checked?[...candidate.selected,i]:candidate.selected.filter(n=>n!==i)})
              }}>{s.text}</Checkbox><div style={{paddingLeft:24}}><Typography.Text type="secondary">{s.reason}</Typography.Text></div></div>)}
              <Typography.Text type="secondary">勾选后加入候选，取消时移除对应原句；如已手工改写，请直接编辑候选。</Typography.Text>
            </div>}
            {!!candidate.notes.length&&<Collapse items={[{key:'notes',label:`前文核对提醒（${candidate.notes.length} 条，仅供参考）`,children:candidate.notes.map((n,i)=><p key={i}>{n}</p>)}]}/>}
            <Space wrap><Button disabled={!!busy||candidate.stale||!candidate.outline.trim()} onClick={()=>void save()}>保存候选</Button>
              {dirty&&<Button disabled={!!busy} onClick={reload}>撤销未保存修改</Button>}
              <Button type="primary" disabled={!!busy||candidate.stale||!candidate.outline.trim()} loading={busy==='adopt'} onClick={()=>void save(true)}>采纳为当前台本</Button>
              <Typography.Text type="secondary">采纳不修改正文或已确认的记忆。</Typography.Text>
            </Space>
          </>}
        </Space>},
        {key:'versions',label:`台本版本${data?.versions.length?`（${data.versions.length}）`:''}`,children:<Space direction="vertical" style={{width:'100%'}}>
          {!data?.versions.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采纳候选或恢复历史版本时，会自动保留当前台本"/>:<Collapse accordion onChange={async keys=>{
            const key=Array.isArray(keys)?keys[0]:keys;setVersion(null);if(!key)return
            setBusy('version');setError('')
            try{const r=await api.get(`${url}/outline-versions/${key}`);setVersion(r.data)}catch(e){fail(e)}finally{setBusy('')}
          }} items={data.versions.map(v=>({key:String(v.id),label:`${v.note} · ${v.created_at} · ${v.created_by}`,children:version?.id===v.id?<>
            <pre style={{whiteSpace:'pre-wrap',fontFamily:'inherit'}}>{version.outline||'（空台本）'}</pre>
            <Button disabled={!!busy||dirty} onClick={()=>void restore()}>恢复为当前台本</Button>
            {dirty&&<Typography.Text type="secondary"> 请先保存候选修改。</Typography.Text>}
          </>:null}))}/>}
        </Space>},
      ]}/>
    </Spin>
  </Drawer>
}
