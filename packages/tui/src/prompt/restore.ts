import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { isMissingMedia } from "../util/media"
import { restoredPromptInput, type ProjectedPrompt } from "./codec"
import type { PromptInfo } from "./history"

/**
 * Reads a sent prompt back for the composer before an undo or revert lets the server sweep its images. An image the
 * server no longer has is left out with a warning, so it can't block the rewind; any other failed read rejects, since
 * that image may still exist and the rewind could delete it.
 */
export function usePromptRestore() {
  const client = useClient()
  const toast = useToast()
  return async (input: ProjectedPrompt): Promise<PromptInfo> => {
    let missing = 0
    const prompt = await restoredPromptInput(input, (uri) =>
      client.media.read(uri).catch((error) => {
        if (!isMissingMedia(error)) throw error
        missing++
        return undefined
      }),
    )
    if (missing)
      toast.show({
        message:
          missing === 1
            ? "An image in this message is no longer stored, so it can't be restored"
            : `${missing} images in this message are no longer stored, so they can't be restored`,
        variant: "warning",
      })
    return { ...prompt, pasted: [] }
  }
}
