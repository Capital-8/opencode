import { mediaHashFromUri } from "@opencode/client"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useClient } from "../context/client"

/**
 * An `<image>` source for a URI that may be a `media:<hash>` ref. A ref reads its bytes from the server once something
 * shows it, so images nobody looks at fetch nothing; other URIs pass through.
 */
export function createMediaSource(uri: Accessor<string>) {
  const client = useClient()
  const [bytes, setBytes] = createSignal(client.media.peek(uri()))
  const [failed, setFailed] = createSignal(false)

  createEffect(
    on(uri, (current) => {
      setFailed(false)
      const cached = client.media.peek(current)
      setBytes(cached)
      if (cached || !mediaHashFromUri(current)) return
      let active = true
      onCleanup(() => {
        active = false
      })
      client.media.read(current).then(
        (result) => {
          if (active) setBytes(result)
        },
        () => {
          if (active) setFailed(true)
        },
      )
    }),
  )

  return {
    source: (): string | Uint8Array | undefined => (mediaHashFromUri(uri()) ? bytes() : uri()),
    failed,
  }
}
