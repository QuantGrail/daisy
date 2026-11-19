import React, { useEffect, useState, useRef } from "react";
import { View, Modal, Platform } from "react-native";
import { TerminalFrame } from "./terminal-frame";
import { DaisyClient } from "@daisy-ai/client";
import { Text, Button, ErrorBox } from "./primitives";
import { useDaisyTheme, type DaisyColors } from "./theme";
import { t as tr, useT } from "./i18n";
import { terminalPageUrl } from "./terminal-url";
function terminalHtml(
  baseUrl: string,
  token: string,
  sid: string,
  jid: string,
  C: DaisyColors,
) {
  const css = (v: string) => v.replace(/[^#\w(),.% -]/g, "");
  const assetBase = baseUrl.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
  const L = {
    failed: tr("ui-chat.terminal.failed"),
    inputRetry: tr("ui-chat.terminal.inputRetry"),
    truncated: tr("ui-chat.terminal.truncated"),
    ended: tr("ui-chat.terminal.ended"),
    waiting: tr("ui-chat.terminal.waiting"),
    connected: tr("ui-chat.terminal.connected"),
    reconnecting: tr("ui-chat.terminal.reconnecting"),
  };
  const esc = (v: string) =>
    v.replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
          c
        ]!,
    );
  const config = JSON.stringify({ baseUrl, token, sid, jid, L }).replace(
    /</g,
    "\\u003c",
  );
  return String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><link rel="stylesheet" href="${assetBase}/terminal-assets/xterm.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${css(C.terminalBg)};color:${css(C.terminalMuted)};font:12px system-ui}#status{padding:8px;height:18px}#keys{display:flex;gap:6px;padding:8px;height:30px}button{background:${css(C.terminalKey)};color:${css(C.terminalKeyInk)};border:0;border-radius:5px;padding:6px 12px}#term{height:calc(100% - 80px);padding:0 8px}</style></head><body><div id="status">${esc(tr("ui-chat.terminal.connecting"))}</div><div id="keys"><button data-key="esc">Esc</button><button data-key="tab">Tab</button><button data-key="up">↑</button><button data-key="down">↓</button><button data-key="ctrlc">Ctrl C</button><button data-key="ctrls">Ctrl S</button><button data-key="enter">Enter</button></div><div id="term"></div><script src="${assetBase}/terminal-assets/xterm.js"></script><script src="${assetBase}/terminal-assets/fit.js"></script><script>
const c=${config},status=document.getElementById('status');
const term=new Terminal({cursorBlink:true,fontSize:13,scrollback:5000,theme:{background:'${css(C.terminalBg)}',foreground:'${css(C.terminalInk)}'},allowProposedApi:false});const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('term'));
const path='/sessions/'+c.sid+'/terminal/'+c.jid;
let cursor=0,finished=false,reading=false,writing=false,buffer='',pending=null;
const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
async function api(path,body){const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),10000);try{const r=await fetch(c.baseUrl+'/api'+path,{method:body?'POST':'GET',headers:{...(c.token?{'Authorization':'Bearer '+c.token}:{}),'Content-Type':'application/json'},signal:abort.signal,...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||c.L.failed);return data;}finally{clearTimeout(timer);}}
async function send(){if(writing||finished||(!buffer&&!pending))return;writing=true;if(!pending){pending={id:uid(),text:buffer};buffer='';}try{await api(path+'/input',pending);pending=null;}catch(e){status.textContent=c.L.inputRetry+e.message;}finally{writing=false;}}
term.onData(s=>{buffer+=s;});setInterval(send,80);
function resize(){fit.fit();if(!finished)api(path+'/input',{id:uid(),cols:Math.max(20,term.cols),rows:Math.max(5,term.rows)}).catch(()=>{});}
new ResizeObserver(resize).observe(document.getElementById('term'));setTimeout(resize,100);
const keys={esc:'\x1b',tab:'\t',up:'\x1b[A',down:'\x1b[B',ctrlc:'\x03',ctrls:'\x13',enter:'\r'};document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>{buffer+=keys[b.dataset.key];term.focus();});
async function poll(){if(reading||finished)return;reading=true;try{const r=await api(path+'/output?after='+cursor);if(r.truncated){term.reset();status.textContent=c.L.truncated;}for(const x of r.chunks){term.write(Uint8Array.from(atob(x.data),s=>s.charCodeAt(0)));cursor=x.seq;}if(!['queued','running'].includes(r.status)&&r.chunks.length<100){finished=true;status.textContent=c.L.ended+r.status;}else status.textContent=r.status==='queued'?c.L.waiting:c.L.connected;}catch(e){status.textContent=c.L.reconnecting+e.message;}finally{reading=false;}}
setInterval(poll,300);poll();
</script></body></html>`;
}
export function NativeTerminal({
  client,
  sessionId,
  onClose,
}: {
  client: DaisyClient;
  sessionId: string;
  onClose: () => void;
}) {
  const [job, setJob] = useState<string | null>(null),
    [error, setError] = useState(""),
    [stopping, setStopping] = useState(false);
  const html = useRef(""),
    src = useRef("");
  const { C, s } = useDaisyTheme();
  const t = useT();
  useEffect(() => {
    let closed = false;
    void (async () => {
      try {
        const current = await client.request(`/sessions/${sessionId}/terminal`);
        const id =
          current.job && ["queued", "running"].includes(current.job.status)
            ? current.job.id
            : (await client.operation(sessionId, "terminal")).id;
        if (!closed) {
          if (Platform.OS === "web")
            src.current = terminalPageUrl(
              client.baseUrl,
              client.token,
              sessionId,
              id,
              C,
              t.lang,
            );
          else
            html.current = terminalHtml(
              client.baseUrl,
              client.token,
              sessionId,
              id,
              C,
            );
          setJob(id);
        }
      } catch (e: any) {
        if (!closed) setError(e.message);
      }
    })();
    return () => {
      closed = true;
    };
  }, [client, sessionId]);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: C.terminalBg,
          paddingTop: Platform.OS === "ios" ? 45 : 12,
        }}
      >
        <View style={[s.row, { padding: 12, flexWrap: "wrap" }]}>
          <Text style={{ color: C.terminalInk, flex: 1 }}>{t("ui-chat.terminal.title")}</Text>
          <Button variant="soft" onPress={onClose}>
            {t("ui-chat.terminal.hide")}
          </Button>
          <Button
            variant="danger"
            busy={stopping}
            onPress={() => {
              setStopping(true);
              void client
                .cancel(sessionId)
                .then(onClose)
                .catch((e) => setError(e.message))
                .finally(() => setStopping(false));
            }}
          >
            {t("ui-chat.terminal.stop")}
          </Button>
        </View>
        <ErrorBox text={error} />
        {job ? (
          <View style={{ flex: 1 }}>
            <TerminalFrame
              html={html.current}
              src={src.current}
              token={client.token}
              baseUrl={client.baseUrl}
              background={C.terminalBg}
            />
          </View>
        ) : (
          <Text style={{ color: C.terminalInk, padding: 20 }}>
            {error ? t("ui-chat.terminal.notStarted") : t("ui-chat.terminal.starting")}
          </Text>
        )}
        <Text style={{ color: C.terminalMuted, fontSize: 11, padding: 12 }}>
          {t("ui-chat.terminal.note")}
        </Text>
      </View>
    </Modal>
  );
}
