// It defines two things:

// The state: the shared data every step reads and writes.
// The graph: which step runs after which, and under what conditions.

//annotations are used to define the structure of the state, including the types of each field and how they should be updated. 
//stategraph is used to define the flow of the crawl, including the nodes and edges that represent the different steps in the process.
//start/end are used to define the entry and exit points of the graph, respectively.
//memorysaver is used to save the state of the graph in memory, allowing it to be paused and resumed later.
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  actNode,
  afterApprove,
  afterEvaluate,
  afterSelect,
  approveNode,
  evaluateNode,
  initNode,
  observeNode,
  planNode,
  reportNode,
  selectNode,
} from "./nodes.js";

// Graph state: plain data only. Every field is "last value wins"; nodes
// return the full updated value for whatever they change.
const CrawlState = Annotation.Root({
  scanId: Annotation(),
  startUrl: Annotation(),
  origin: Annotation(),
  // Landing page analysis (the original single-page prompt's output).
  landing: Annotation({ reducer: (_, v) => v, default: () => null }),
  // Discovered screens, keyed by fingerprint.
  states: Annotation({ reducer: (_, v) => v, default: () => ({}) }),
  currentStateId: Annotation(),
  currentSnapshot: Annotation({ reducer: (_, v) => v, default: () => null }),
  // To-do list of actions, sorted by priority (highest first).
  frontier: Annotation({ reducer: (_, v) => v, default: () => [] }),
  triedKeys: Annotation({ reducer: (_, v) => v, default: () => [] }),
  pending: Annotation({ reducer: (_, v) => v, default: () => null }),
  decision: Annotation({ reducer: (_, v) => v, default: () => null }),
  lastResult: Annotation({ reducer: (_, v) => v, default: () => null }),
  actionsLog: Annotation({ reducer: (_, v) => v, default: () => [] }),
  bugs: Annotation({ reducer: (_, v) => v, default: () => [] }),
  skipped: Annotation({ reducer: (_, v) => v, default: () => [] }),
  counters: Annotation({ reducer: (_, v) => v, default: () => ({ actions: 0, noNovelty: 0 }) }),
  stopReason: Annotation({ reducer: (_, v) => v, default: () => null }),
  finalReport: Annotation({ reducer: (_, v) => v, default: () => null }),
});

//  init → observe → plan → select ─┬─→ approve ─┬─→ act → evaluate ─┬─→ observe (new screen)
//                     ▲            │            └─→ select (skipped) └─→ select
//                     │            └─→ report → END (budget hit / nothing left)
//                     └─ observe ←─ (new explorable screen)
export function buildCrawlGraph() {
  const graph = new StateGraph(CrawlState)
    .addNode("init", initNode)
    .addNode("observe", observeNode)
    .addNode("plan", planNode)
    .addNode("select", selectNode)
    .addNode("approve", approveNode)
    .addNode("act", actNode)
    .addNode("evaluate", evaluateNode)
    .addNode("report", reportNode)
    .addEdge(START, "init")
    .addEdge("init", "observe")
    .addEdge("observe", "plan")
    .addEdge("plan", "select")
    .addConditionalEdges("select", afterSelect, ["approve", "report"])
    .addConditionalEdges("approve", afterApprove, ["act", "select"])
    .addEdge("act", "evaluate")
    .addConditionalEdges("evaluate", afterEvaluate, ["observe", "select"])
    .addEdge("report", END);

  // The checkpointer is what lets interrupt() pause a scan mid-graph and
  // resume it later with the user's answer.
  return graph.compile({ checkpointer: new MemorySaver() });
}
