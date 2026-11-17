import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, theme, window, shared, setShared, layout, settings, props, nextCommand, notify, exec, home, keys, checking } from "herdr";

// Pinned tabs: their ids in shared state, so a pin outlives a restart and a layout switch.
const PINS = "tab-pin.pinned";
const pins = () => new Set(shared(PINS) ?? []);
// Drops ids of tabs that are gone, so the list never grows.
const setPins = (ids) => { const live = new Set(spaces().flatMap(s => s.tabs).map(t => t.id)); setShared(PINS, [...ids].filter(id => live.has(id))); };
const togglePin = (id) => { const p = pins(); p.has(id) ? p.delete(id) : p.add(id); setPins(p); };
const activeTab = () => spaces().find(s => s.active)?.tabs.find(t => t.active)?.id;

// The key bound to an action, for the menu: this layout's own section first, then global.
function shortcut(action) {
  for (const section of [`layout:${shared("layout")}`, "global"]) {
    const k = keys().find(b => b.section === section && b.action === action);
    if (k) return k.keys;
  }
  return "";
}

// Every close of a tab from this bar or its keys comes here. A pinned tab doesn't close: a toast
// offers Unpin and close. A space's last tab opens the space-welcome mod (if installed) in its place,
// so the space stays; without it, Herdr's own close (which asks before the space goes).
let welcome = false;
function closeTab(id) {
  if (!id) return;
  if (pins().has(id)) {
    setShared("tab-pin.unpinclose", id);
    notify({ title: "Tab is pinned", body: "Unpin it to close it.", icon: "mods/tab-pin/pin.svg", action: { name: "tab-pin.unpin-close" } });
    return;
  }
  const space = spaces().find(s => s.tabs.some(t => t.id === id));
  if (welcome && space?.tabs.length === 1) {
    run("tab.new", { space: space.id, name: "Welcome", mod: "space-welcome", props: { space: space.id } });
    run("tab.close", { id, confirmed: true });
    return;
  }
  run("tab.close", { id });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Tabs extends View {
  init(_props, cx) {
    if (props()?.menu) {
      this.at = 0;
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    if (!checking()) {
      exec("test", ["-d", `${home()}/.config/herdr-app/mods/space-welcome`]).then(r => { welcome = r.code === 0; }).catch(() => {});
      // Keys: close (cmd-w), pin (toggle the shown tab), unpin-close (the pinned toast's button).
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "close") closeTab(activeTab());
          else if (c === "pin" && activeTab()) togglePin(activeTab());
          else if (c === "unpin-close") {
            const id = shared("tab-pin.unpinclose");
            if (id) { togglePin(id); closeTab(id); }
          }
          cx.notify();
        }
      });
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // The tab's right-click menu: Pin/Unpin, Rename, New tab, Close. ↑/↓ move, Enter runs, Esc closes.
  renderMenu() {
    const t = theme(), { id, space } = props().menu, pinned = pins().has(id);
    const rows = [
      { label: pinned ? "Unpin" : "Pin", icon: pinned ? "pin-off" : "pin", act: () => togglePin(id), keys: shortcut("tab-pin.pin") },
      { label: "Rename", icon: "square-pen", act: () => run("tab.rename", { id }), keys: shortcut("tab.rename") },
      { label: "New tab", icon: "plus", act: () => run("tab.new", { space }), keys: shortcut("tab.new") },
      { label: "Close", icon: "close", sep: true, act: () => closeTab(id), keys: shortcut("tab-pin.close") || shortcut("tab.close") },
    ];
    const choose = (i) => { closeOverlay(props().overlay); rows[i]?.act(); };
    return v_flex().id("menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (e.key === "down") this.at = (this.at + 1) % rows.length;
        else if (e.key === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else if (e.key === "enter") return choose(this.at);
        else return;
        cx.notify();
      })
      .children(rows.map((it, i) => v_flex()
        .when(Boolean(it.sep), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`mi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click(() => choose(i))
          .child(svg(`mods/tab-pin/${it.icon}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(it.label))
          .child(div().text_size(11).text_color(t.dim).child(it.keys)))));
  }

  // Pinned tabs go first, in the order they sit now. A drag or a new tab can break that: move the first
  // misplaced one back (one move per render; the next render does the next), at most every 300 ms.
  keepPinnedFirst(space, pinned) {
    if (!space || checking() || Date.now() - (this.moved ?? 0) < 300) return;
    const tabs = space.tabs, want = [...tabs.filter(x => pinned.has(x.id)), ...tabs.filter(x => !pinned.has(x.id))];
    const i = want.findIndex((x, k) => tabs[k].id !== x.id);
    if (i < 0) return;
    this.moved = Date.now();
    run("tab.move", { id: want[i].id, index: i + 1 });
  }

  render() {
    if (props()?.menu) return this.renderMenu();
    const t = theme();
    const space = spaces().find(p => p.active);
    const pinned = pins();
    this.keepPinnedFirst(space, pinned);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "tab-pin", kind: "popup", width: 210, height: 145, props: { menu: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(pinned.has(c.id), el => el.child(svg("mods/tab-pin/pin.svg").size(12).flex_none().text_color(t.dim)))
        .when(c.status === "working", el => el.child(svg("mods/tab-pin/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active && !pinned.has(c.id), el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); closeTab(c.id); }).child(svg("mods/tab-pin/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tab-pin/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tab-pin/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tab-pin/win-close.svg").size(16) : svg("mods/tab-pin/close.svg").size(13), () => run("window.close"))));
  }
}
