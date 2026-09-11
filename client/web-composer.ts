// Compatibility with the web renderer's 0.8.0 button-only composer API.
// Restore rich content only when both its button and floating track are known.
// Reserving space for the ENTIRE track is mandatory: a larger transparent icon
// inside an absolute overlay would cover the transcript behind it.
type Style = {
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
};
type Element = {
  parentElement: Element | null;
  children: ArrayLike<Element>;
  style: Style;
  ownerDocument?: { defaultView?: { getComputedStyle(element: Element): Style } | null };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function expandWebComposer(mount: unknown, background: string): (() => void) | null {
  const root = mount as Element | null;
  const slot = root?.parentElement;
  const button = slot?.parentElement;
  const view = root?.ownerDocument?.defaultView;
  // The tooltip adds a display:contents wrapper in the real desktop app.
  // It has no layout box; skip only these single-child transparent wrappers.
  let track = button?.parentElement;
  for (let i = 0; i < 2 && track && view &&
      view.getComputedStyle(track).getPropertyValue("display") === "contents" &&
      track.children.length === 1; i++) track = track.parentElement;
  const bar = track?.parentElement;
  const content = bar?.parentElement;
  if (!slot?.style || !button?.style || !track?.style || !bar?.style || !content || !view ||
      button.getAttribute?.("role") !== "button" || slot.children.length !== 1 ||
      bar.children.length !== 1 || content.children.length < 2 ||
      view.getComputedStyle(track).getPropertyValue("flex-direction") !== "row" ||
      view.getComputedStyle(bar).getPropertyValue("position") !== "absolute" ||
      view.getComputedStyle(content).getPropertyValue("display") !== "flex" ||
      view.getComputedStyle(content).getPropertyValue("flex-direction") !== "column") return null;

  const undo: (() => void)[] = [];
  function patch(element: Element, values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      const previous = element.style.getPropertyValue(key);
      const priority = element.style.getPropertyPriority(key);
      element.style.setProperty(key, value, "important");
      undo.push(() => {
        if (previous) element.style.setProperty(key, previous, priority);
        else element.style.removeProperty(key);
      });
    }
  }
  // A normal, nonshrinking flex child reduces the transcript viewport by its
  // measured height, including wrapped rows and neighboring task/diff pills.
  patch(bar, { position: "relative", left: "auto", right: "auto", bottom: "auto", "flex-shrink": "0", "padding-top": "8px", "background-color": background });
  patch(track, { "flex-wrap": "wrap", "row-gap": "6px" });
  patch(slot, { width: "auto", height: "auto", overflow: "visible", "flex-shrink": "1", "min-width": "0", "pointer-events": "auto" });
  // Keep Paseo's own opaque surface, border and rounded frame behind the data.
  patch(button, { "max-width": "100%", height: "auto" });
  for (const child of Array.from(button.children)) {
    if (child !== slot) patch(child, { display: "none" });
  }
  const hidden = slot.getAttribute("aria-hidden");
  slot.removeAttribute("aria-hidden");
  undo.push(() => { if (hidden === null) slot.removeAttribute("aria-hidden"); else slot.setAttribute("aria-hidden", hidden); });
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
  };
}
