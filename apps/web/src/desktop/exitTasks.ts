// Coordinates awaitable SPA work before the native host completes an exit
type DesktopExitTask = () => Promise<unknown>

const exitTasks = new Set<DesktopExitTask>()

// Registers one async operation that must settle before desktop exit completes
export function registerDesktopExitTask(task: DesktopExitTask): () => void {
  exitTasks.add(task)
  return () => exitTasks.delete(task)
}

// Waits for all mounted desktop exit tasks without letting one failure block exit
export async function runDesktopExitTasks(): Promise<void> {
  const pending = [...exitTasks].map(async (task) => task())
  await Promise.allSettled(pending)
}
