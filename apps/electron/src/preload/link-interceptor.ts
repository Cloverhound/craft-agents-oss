export function shouldInterceptUrl(url: URL): boolean {
  // Keep in-app file navigation untouched, forward external/deep links to host shell.
  if (url.protocol === 'file:') return false
  return [ 'http:', 'https:', 'mailto:', 'craftagents:' ].includes(url.protocol)
}

export function installAnchorInterceptor(
  sendOpenUrlToHost: (url: string) => void,
  win: Pick<Window, 'addEventListener' | 'location'> = window,
): void {
  const handlePointerOpen = (event: MouseEvent): void => {
    if (event.defaultPrevented) return
    if (event.button !== 0 && event.button !== 1) return

    const target = event.target as HTMLElement | null
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    if (!anchor.href) return

    let parsed: URL
    try {
      parsed = new URL(anchor.href, win.location.href)
    } catch {
      return
    }

    if (!shouldInterceptUrl(parsed)) return

    event.preventDefault()
    event.stopPropagation()
    sendOpenUrlToHost(parsed.toString())
  }

  win.addEventListener('click', handlePointerOpen, true)
  win.addEventListener('auxclick', handlePointerOpen, true)
}
