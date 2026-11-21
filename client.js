/**
 * dsh-session-hub — browser half.
 *
 * The browser event bus (P2-⑩) lands in the next minor. Until then this shell
 * registers no slot and performs no request: it only proves that the package
 * ships a lazy client bundle.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-hub',
  factory(require) {
    return {
      inject: [],
      apply() {},
    }
  },
})
