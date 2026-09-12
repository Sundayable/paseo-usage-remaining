// Compatibility for the native 0.8 fixed-icon composer. Keep mutations scoped to
// the owning button and its track, and restore every native prop on teardown.
type NativeNode = { setNativeProps(props: Record<string, unknown>): void };
type Canonical = { currentProps?: unknown; publicInstance?: NativeNode; nativeTag: number; viewConfig: unknown; internalInstanceHandle: unknown };
type Fiber = { return?: Fiber; child?: Fiber; sibling?: Fiber; memoizedProps?: Record<string, any>; stateNode?: any };
type Mount = NativeNode & { __internalInstanceHandle?: Fiber; constructor: any };

// Paseo's own git diff badge shares this track and 0.8 has no setting to hide it.
// It mounts only while a workspace has changes and re-renders whenever the counts
// move, so an imperative style is reapplied whenever the host commits new props.
const DIFF_PILL_TEST_ID = 'composer-diff-stat-pill';
const DIFF_REAPPLY_MS = 400;
const DIFF_RESCAN_TICKS = 5;

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
  // Our own subtree is never a search target: the plugin owns everything below the slot.
  function findHost(fiber: Fiber | undefined, testID: string): Fiber | null {
    if (!fiber || fiber === slot.fiber) return null;
    if (fiber.stateNode?.canonical && fiber.memoizedProps?.testID === testID) return fiber;
    for (let child = fiber.child; child; child = child.sibling) {
      const found = findHost(child, testID);
      if (found) return found;
    }
    return null;
  }
  function nodeFor(fiber: Fiber): NativeNode {
    const canonical: Canonical = fiber.stateNode.canonical;
    const node: NativeNode = canonical.publicInstance ?? new root!.constructor(canonical.nativeTag, canonical.viewConfig, canonical.internalInstanceHandle);
    if (typeof node.setNativeProps !== 'function') throw new Error('Unsupported native host');
    return node;
  }
  const changes: { node: NativeNode; restore: Record<string, any> }[] = [];
  function patch(host: typeof slot, style: Record<string, any>) {
    const node = nodeFor(host.fiber);
    const restore = Object.fromEntries(Object.keys(style).map(key => [key, host.style[key] ?? null]));
    changes.push({ node, restore });
    node.setNativeProps({ style });
  }
  let diff: { canonical: Canonical; node: NativeNode; props: unknown } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  function hideDiffPill() {
    if (!diff) return;
    try {
      diff.node.setNativeProps({ style: { display: 'none' } });
      diff.props = diff.canonical.currentProps;
    } catch { diff = null; /* The badge unmounted; the next scan finds its replacement. */ }
  }
  // A remounted badge is a new host instance, so compare the canonical, not the fiber.
  function scanDiffPill() {
    const fiber = findHost(track!.fiber, DIFF_PILL_TEST_ID);
    if (!fiber) { diff = null; return; }
    if (diff?.canonical === fiber.stateNode.canonical) return;
    try { diff = { canonical: fiber.stateNode.canonical, node: nodeFor(fiber), props: undefined }; } catch { diff = null; return; }
    hideDiffPill();
  }
  const cleanup = () => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (diff) {
      try { diff.node.setNativeProps({ style: { display: null } }); } catch { /* An unmounted node cannot be restored. */ }
      diff = null;
    }
    for (const {node, restore} of changes.splice(0).reverse()) {
      try { node.setNativeProps({style:restore}); } catch { /* An unmounted node cannot be restored. */ }
    }
  };
  try {
    patch(bar, { position: 'relative', left: null, right: null, bottom: null, flexShrink: 0, paddingTop: 8, backgroundColor: background });
    patch(track, { flexWrap: 'wrap', rowGap: 6 });
    patch(button, { maxWidth: width, width, height: 'auto', flexShrink: 1 });
    patch(labels[0], { display: 'none' });
    // The host icon slot centers its single child, which left a wide gutter once the
    // slot became full width. Align the rows to the button's own text edge instead.
    patch(slot, { width: width - 26, height: 'auto', overflow: 'visible', flexShrink: 1, alignItems: 'flex-start' });
    // The badge is optional: a failure here must never cost the usage strip.
    let ticks = 0;
    scanDiffPill();
    timer = setInterval(() => {
      if (diff && diff.canonical.currentProps !== diff.props) hideDiffPill();
      if (++ticks % DIFF_RESCAN_TICKS === 0) scanDiffPill();
    }, DIFF_REAPPLY_MS);
    return cleanup;
  } catch { cleanup(); return null; }
}
