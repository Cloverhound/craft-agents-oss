import { describe, it, expect, mock } from 'bun:test'
import { installAnchorInterceptor, shouldInterceptUrl } from '../link-interceptor'

function createEvent(anchorHref: string, options?: { button?: number; prevented?: boolean }) {
  const preventDefault = mock(() => {})
  const stopPropagation = mock(() => {})
  const anchor = { href: anchorHref }
  const target = {
    closest: (selector: string) => (selector === 'a[href]' ? anchor : null),
  }

  return {
    button: options?.button ?? 0,
    defaultPrevented: options?.prevented ?? false,
    target,
    preventDefault,
    stopPropagation,
  }
}

describe('preload link interception', () => {
  it('intercepts external protocols and ignores file protocol', () => {
    expect(shouldInterceptUrl(new URL('https://craft.do'))).toBe(true)
    expect(shouldInterceptUrl(new URL('mailto:test@example.com'))).toBe(true)
    expect(shouldInterceptUrl(new URL('craftagents://app/open'))).toBe(true)
    expect(shouldInterceptUrl(new URL('file:///tmp/index.html'))).toBe(false)
  })

  it('sends APP_OPEN_URL payload for left click on external links', () => {
    const listeners = new Map<string, (event: MouseEvent) => void>()
    const sendOpenUrl = mock((_url: string) => {})

    installAnchorInterceptor(sendOpenUrl, {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        listeners.set(type, handler as (event: MouseEvent) => void)
      },
      location: { href: 'file:///app/index.html' } as Location,
    })

    const event = createEvent('https://github.com/cloverhound')
    listeners.get('click')?.(event as unknown as MouseEvent)

    expect(sendOpenUrl).toHaveBeenCalledTimes(1)
    expect(sendOpenUrl).toHaveBeenCalledWith('https://github.com/cloverhound')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('does not intercept file links', () => {
    const listeners = new Map<string, (event: MouseEvent) => void>()
    const sendOpenUrl = mock((_url: string) => {})

    installAnchorInterceptor(sendOpenUrl, {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        listeners.set(type, handler as (event: MouseEvent) => void)
      },
      location: { href: 'file:///app/index.html' } as Location,
    })

    const event = createEvent('file:///tmp/inside-app.html')
    listeners.get('click')?.(event as unknown as MouseEvent)

    expect(sendOpenUrl).toHaveBeenCalledTimes(0)
    expect(event.preventDefault).toHaveBeenCalledTimes(0)
    expect(event.stopPropagation).toHaveBeenCalledTimes(0)
  })
})
