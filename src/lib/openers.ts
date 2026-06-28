import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { getErrorMessage } from "./error";

export async function openSkillFolder(path: string | null | undefined, fallbackError: string) {
  if (!path) {
    toast.error(fallbackError);
    return;
  }

  try {
    await openPath(path);
  } catch (error: unknown) {
    toast.error(getErrorMessage(error, fallbackError));
  }
}
