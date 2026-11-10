import type { Jail } from './harness/jail'
import { readFileTool } from './harness/tools/read-file'
import { createRegistry, type ToolRegistry } from './harness/tools/registry'
import { writeFileTool } from './harness/tools/write-file'

/**
 * Which tools a run gets, in one place that a test can call.
 *
 * The choice lives here rather than inside the `startRun` handler body because that body is the only
 * place a real run has ever built its registry, and no test may reach it: a test cannot call a server
 * function, and the bridge file exports nothing but server functions — a plain function exported from
 * that file is handed to the browser along with everything it imports, which for these tools means
 * Node's filesystem. So the handler keeps the half it must keep, opening the jail over the configured
 * directory, and hands the jail here.
 *
 * It takes a jail and builds nothing else. A tool that touches a file cannot be constructed without one,
 * so the order is forced: a caller that wants a registry must first decide which directory the run is
 * confined to. The list is declaration order, which is the order a provider is shown.
 *
 * Nothing framework appears in this file, which is what makes it importable from a test.
 */
export function toolRegistryForRun(jail: Jail): ToolRegistry {
  return createRegistry([readFileTool({ jail }), writeFileTool({ jail })])
}
