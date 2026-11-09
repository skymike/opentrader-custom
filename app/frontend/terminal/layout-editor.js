const storageKey = "opentrader-panel-layout-v1";
const desktop = matchMedia("(min-width: 1200px) and (min-height: 640px)");

export function mountLayoutEditor(grid) {
  const panels = [
    [".terminal-ai", "AI analysis"], [".sentiment-panel", "Fear & Greed"],
    [".market-terminal", "Chart"], [".terminal-bottom", "Account activity"],
    [".trading-panel", "Execution"], [".approval-panel", "Approvals"],
    [".compact-agents", "Agents"],
  ].map(([selector, name]) => ({ node: grid.querySelector(selector), name }));
  const toolbar = document.querySelector(".toolbar");
  const toggle = button("Layout");
  const reset = button("Reset layout");
  reset.hidden = true;
  toolbar.prepend(toggle, reset);
  let boxes;
  let editing = false;
  let gesture;
  const bounds = () => grid.getBoundingClientRect();
  const copy = items => items.map(box => ({ ...box }));
  const overlaps = (a, b) => a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001 &&
    a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001;
  const valid = box => box && [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
    box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 &&
    box.x + box.w <= 1.001 && box.y + box.h <= 1.001;

  function button(label) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "secondary";
    control.textContent = label;
    return control;
  }
  function capture() {
    const area = bounds();
    return panels.map(({ node }) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.max(0, (rect.left - area.left) / area.width),
        y: Math.max(0, (rect.top - area.top) / area.height),
        w: rect.width / area.width, h: rect.height / area.height };
    });
  }
  function render() {
    const custom = desktop.matches && boxes;
    grid.classList.toggle("custom-panels", Boolean(custom));
    grid.classList.toggle("editing-panels", editing && desktop.matches);
    toggle.hidden = !desktop.matches;
    toggle.textContent = editing ? "Done" : "Layout";
    toggle.setAttribute("aria-pressed", String(editing));
    reset.hidden = !editing;
    if (!custom) return;
    panels.forEach(({ node }, index) => {
      const box = boxes[index];
      for (const [key, value] of Object.entries(box)) node.style.setProperty("--panel-" + key, value * 100 + "%");
    });
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(boxes)); } catch { /* Layout still works in this tab. */ }
  }
  function apply(index, source, dx, dy, resize, commit, pointer) {
    const area = bounds();
    const next = copy(source);
    const original = source[index];
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const candidate = resize ? {
      ...original,
      w: clamp(original.w + dx, Math.min(original.w, 160 / area.width), 1 - original.x),
      h: clamp(original.h + dy, Math.min(original.h, 72 / area.height), 1 - original.y),
    } : { ...original,
      x: clamp(original.x + dx, 0, 1 - original.w),
      y: clamp(original.y + dy, 0, 1 - original.h),
    };
    if (!resize && commit) {
      const x = pointer?.x ?? candidate.x + candidate.w / 2;
      const y = pointer?.y ?? candidate.y + candidate.h / 2;
      const target = source.findIndex((box, i) => i !== index &&
        x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h);
      if (target >= 0) {
        next[index] = source[target];
        next[target] = original;
        boxes = next;
        return;
      }
    }
    if (commit && source.some((box, i) => i !== index && overlaps(candidate, box))) return;
    next[index] = candidate;
    boxes = next;
  }

  panels.forEach(({ node, name }, index) => {
    node.classList.add("editable-panel");
    for (const resize of [false, true]) {
      const handle = button(resize ? "↘" : "⠿");
      const action = resize ? "Resize " : "Move ";
      handle.classList.add(resize ? "panel-resize" : "panel-move");
      handle.title = action + name + " (drag or use arrow keys)";
      handle.setAttribute("aria-label", action + name);
      node.append(handle);
      handle.addEventListener("pointerdown", event => {
        if (!editing || event.button !== 0) return;
        event.preventDefault();
        handle.focus();
        handle.setPointerCapture(event.pointerId);
        gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, source: copy(boxes) };
        node.classList.add("moving-panel");
      });
      const move = (event, commit) => {
        if (gesture?.pointer !== event.pointerId) return;
        const { source, x, y } = gesture;
        const area = bounds();
        boxes = copy(source);
        apply(index, source, (event.clientX - x) / area.width, (event.clientY - y) / area.height, resize, commit,
          { x: (event.clientX - area.left) / area.width, y: (event.clientY - area.top) / area.height });
        if (commit) {
          gesture = undefined;
          node.classList.remove("moving-panel");
          save();
        }
        render();
      };
      handle.addEventListener("pointermove", event => move(event, false));
      handle.addEventListener("pointerup", event => move(event, true));
      handle.addEventListener("lostpointercapture", () => {
        if (!gesture) return;
        boxes = gesture.source;
        gesture = undefined;
        node.classList.remove("moving-panel");
        render();
      });
      handle.addEventListener("keydown", event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!editing || !delta) return;
        event.preventDefault();
        const area = bounds();
        const step = event.shiftKey ? 96 : 16;
        apply(index, boxes, delta[0] * step / area.width, delta[1] * step / area.height, resize, true);
        save();
        render();
      });
    }
  });
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.length === panels.length && saved.every(valid) &&
        saved.every((box, i) => !saved.some((other, j) => i !== j && overlaps(box, other)))) boxes = saved;
  } catch { /* Use defaults if storage is unavailable or invalid. */ }
  toggle.addEventListener("click", () => {
    if (!desktop.matches) return;
    editing = !editing;
    if (editing && !boxes) boxes = capture();
    render();
  });
  reset.addEventListener("click", () => {
    boxes = undefined;
    editing = false;
    save();
    render();
  });
  desktop.addEventListener("change", () => { editing = false; render(); });
  render();
}
