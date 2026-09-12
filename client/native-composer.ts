// Compatibility for the native 0.8 fixed-icon composer. Keep mutations scoped to
// the owning button and its track, and restore every native prop on teardown.
type NativeNode = { setNativeProps(props: Record<string, unknown>): void };
type Fiber = { return?: Fiber; child?: Fiber; sibling?: Fiber; memoizedProps?: Record<string, any>; stateNode?: any };
type Mount = NativeNode & { __internalInstanceHandle?: Fiber; constructor: any };

export function expandNativeComposer(mount: unknown, width: number, background: string, flatten: (style: any) => any): (() => void) | null {
  const root = mount as Mount | null;
  if (!root?.__internalInstanceHandle || !root.setNativeProps) return null;
  const hosts: { fiber: Fiber; props: Record<string, any>; style: Record<string, any> }[] = [];
  for (let fiber = root.__internalInstanceHandle.return, i = 0; fiber && i < 80; fiber = fiber.return, i++) {
    if (fiber.stateNode?.canonical) hosts.push({ fiber, props: fiber.memoizedProps ?? {}, style: flatten(fiber.memoizedProps?.style) ?? {} });
  }
  const slot = hosts[0];
  if (slot?.style.width !== 16 || slot.style.height !== 16 || slot.style.overflow !== 'hidden') return null;
  const button = hosts.find(h => h.props.accessibilityRole === 'button');
  const track = hosts.find(h => h.style.flexDirection === 'row' && h.style.width === '100%');
  const bar = hosts.find(h => h.style.position === 'absolute' && h.style.bottom === 0 && h.style.left === 0 && h.style.right === 0);
  if (!button || !track || !bar || hosts.indexOf(track) <= hosts.indexOf(button) || hosts.indexOf(bar) <= hosts.indexOf(track)) return null;
  const labels: typeof hosts = [];
  function findLabels(fiber?: Fiber) {
    if (!fiber || fiber === slot.fiber) return;
    if (fiber.stateNode?.canonical && fiber.memoizedProps?.numberOfLines === 1 && typeof fiber.memoizedProps.children === 'string') {
      labels.push({ fiber, props: fiber.memoizedProps, style: flatten(fiber.memoizedProps.style) ?? {} });
    }
    for (let child = fiber.child; child; child = child.sibling) findLabels(child);
  }
  findLabels(button.fiber);
  if (labels.length !== 1) return null;
  const changes: { node: NativeNode; restore: Record<string, any> }[] = [];
  function patch(host: typeof slot, style: Record<string, any>) {
    const canonical = host.fiber.stateNode.canonical;
    const node: NativeNode = canonical.publicInstance ?? new root!.constructor(canonical.nativeTag, canonical.viewConfig, canonical.internalInstanceHandle);
    if (typeof node.setNativeProps !== 'function') throw new Error('Unsupported native host');
    const restore = Object.fromEntries(Object.keys(style).map(key => [key, host.style[key] ?? null]));
    changes.push({ node, restore });
    node.setNativeProps({ style });
  }
  const cleanup = () => {
    for (const {node, restore} of changes.splice(0).reverse()) {
      try { node.setNativeProps({style:restore}); } catch { /* An unmounted node cannot be restored. */ }
    }
  };
  try {
    patch(bar, { position: 'relative', left: null, right: null, bottom: null, flexShrink: 0, paddingTop: 8, backgroundColor: background });
    patch(track, { flexWrap: 'wrap', rowGap: 6 });
    patch(button, { maxWidth: width, width, height: 'auto', flexShrink: 1 });
    patch(labels[0], { display: 'none' });
    patch(slot, { width: width - 26, height: 'auto', overflow: 'visible', flexShrink: 1 });
    return cleanup;
  } catch { cleanup(); return null; }
}
