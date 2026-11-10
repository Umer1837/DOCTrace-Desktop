import { c as createRoot, j as jsxRuntimeExports, r as reactExports, d as dt } from "./native-QC5-axeK.js";
const send = (cmd) => dt.events.emit("dt:pill", { cmd });
const clock = (ms) => {
  const s = Math.floor(ms / 1e3);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function Pill() {
  const [st, setSt] = reactExports.useState(null);
  const [now, setNow] = reactExports.useState(Date.now());
  reactExports.useEffect(() => {
    const off = dt.events.on("dt:state", setSt);
    send("hello");
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  const phase = st?.phase ?? "idle";
  const recording = phase === "recording";
  const working = phase === "starting" || phase === "stopping" || phase === "processing";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `pill ${phase}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `dot ${recording ? "live" : ""}` }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "info", children: recording ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: clock(now - (st?.startedAt || now)) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
        st?.captured || 0,
        " steps",
        st?.voice ? st.micSilent ? " · mic silent!" : " · mic on" : ""
      ] })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "msg", children: working ? st?.message || "Working..." : phase === "error" ? st?.message : "Ready to record" }) }),
    recording ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "stop", onClick: () => send("stop"), title: "Stop (Ctrl+Shift+S)", children: "■ Stop" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "start", disabled: working, onClick: () => send("start"), children: "● Record" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "ghost", onClick: () => send("guides"), title: "Open guides", children: "☰" })
  ] });
}
createRoot(document.getElementById("root")).render(/* @__PURE__ */ jsxRuntimeExports.jsx(Pill, {}));
