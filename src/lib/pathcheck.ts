import type { Analysis, NodePlacement } from '../../shared/model';
import { locateSentence } from './analyzer';
import { formatOrdinal } from './numeral';

/**
 * 引用路径核对：用户选定起点条与终点条后，基于当前**已确认**的条级引用边
 * （analysis.edges：组合引用的每个已解析目标各一条边、歧义确认后才成边）
 * 寻找一条跳数最少的有向路径。
 *
 * - BFS 保证最短（跳数最少）；循环通过「已访问集合」剪枝，不会导致重复搜索；
 * - 同一来源句（同一引用 key）对同一目标条只产生一条邻接，同一条对有多条引用时
 *   按正文顺序（条序 → 款 / 项位置 → 字符偏移）选取最先可展示的一条作为证据；
 * - 结果为纯计算的会话内产物：不修改正文与解析图、不进入撤销历史、不持久化；
 *   由界面在正文或歧义确认变化（analysis 重建）时随渲染即时重算，不保留旧证据。
 */

/** 路径上的一跳：来源条经一条引用指向目标条 */
export interface RefPathHop {
  /** 来源条 id */
  fromArticleId: string;
  /** 目标条 id */
  toArticleId: string;
  /** 产生该边的引用所在节点 id（点击来源句定位正文用） */
  sourceNodeId: string;
  /** 引用 key（正文 chip 高亮用） */
  refKey: string;
  /** 引用原文，如「第三条、第五条及第七条」 */
  raw: string;
  /** 该引用在来源节点正文中的字符区间 */
  refStart: number;
  refEnd: number;
  /** 来源句在来源节点正文中的字符区间（点击定位并高亮整句） */
  sentenceStart: number;
  sentenceEnd: number;
  /** 来源定位文字快照，如「第五条第二款第（一）项」 */
  sourceLabel: string;
  /** 该引用为部分缺失的组合 / 区间引用（仍有已解析目标成边，故可作证据） */
  partlyBroken: boolean;
  /** 该引用由用户确认歧义后成边 */
  fromAmbiguityConfirmed: boolean;
  /** 该跳的目标条是否处于引用循环上（分析层检出的条级环） */
  inCycle: boolean;
}

export interface RefPathReport {
  sourceId: string;
  targetId: string;
  /** 最少跳数（0 = 起点即终点） */
  hops: number;
  /** 逐跳证据（hops = 0 时为空） */
  path: RefPathHop[];
  /** BFS 中被剪枝的重复 / 循环回指边数（同一条对按文档顺序只保留一条候选） */
  prunedEdges: number;
}

/** 节点的人类可读定位，如「第五条第二款第（一）项」 */
function placementLabel(p: NodePlacement): string {
  let s = `第${formatOrdinal(p.article.ordinal)}条`;
  if (p.article.suffix) s += `之${p.article.suffix}`;
  if (p.paragraphIndex > 0) s += `第${formatOrdinal(p.paragraphIndex)}款`;
  if (p.itemIndex > 0) s += `第${formatOrdinal(p.itemIndex)}项`;
  return s;
}

/** 引用在正文顺序中的排序键：条序 → 款序 → 项序 → 节点内字符偏移 */
function edgeOrderKey(e: { sourceNodeId: string; refKey: string }, analysis: Analysis): number[] {
  const p = analysis.placement[e.sourceNodeId];
  const ai = p?.articleIndex ?? Number.MAX_SAFE_INTEGER;
  const pi = p?.paragraphIndex ?? 0;
  const ii = p?.itemIndex ?? 0;
  const occ = analysis.occurrences.find((o) => o.key === e.refKey);
  const off = occ?.span.start ?? 0;
  return [ai, pi, ii, off];
}

function lessOrder(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * 计算起点条 → 终点条的最少跳有向路径；不可达时返回 null。
 * 起点条 / 终点条不存在，或二者相同时（0 跳）由调用方先行处理。
 */
export function findRefPath(
  analysis: Analysis,
  sourceId: string,
  targetId: string,
): RefPathReport | null {
  if (!analysis.nodes[sourceId] || !analysis.nodes[targetId]) return null;
  if (sourceId === targetId) {
    return { sourceId, targetId, hops: 0, path: [], prunedEdges: 0 };
  }

  // 条对邻接：from -> (to -> 代表边)。同一条对有多条引用时按正文顺序保留最先可展示的一条
  const adjacency = new Map<string, Map<string, (typeof analysis.edges)[number]>>();
  let prunedEdges = 0;
  // analysis.edges 按 occurrence 扫描顺序生成（即文档顺序），Map 首次写入天然取最早一条；
  // 为不依赖生成顺序的隐含约定，这里仍显式按正文顺序比较。
  for (const e of analysis.edges) {
    if (e.sourceArticleId === e.targetArticleId) continue; // 条内自指不构成条款间路径
    let row = adjacency.get(e.sourceArticleId);
    if (!row) {
      row = new Map();
      adjacency.set(e.sourceArticleId, row);
    }
    const existing = row.get(e.targetArticleId);
    if (!existing) {
      row.set(e.targetArticleId, e);
    } else {
      prunedEdges += 1;
      if (lessOrder(edgeOrderKey(e, analysis), edgeOrderKey(existing, analysis))) {
        row.set(e.targetArticleId, e);
      }
    }
  }

  // 分析层已检出的循环（条级有向环），用于逐跳标注
  const cycleSet = new Set<string>();
  for (const issue of analysis.issues) {
    if (issue.type !== 'cycle') continue;
    for (const id of issue.cycleNodeIds ?? []) cycleSet.add(id);
  }

  // BFS：每条条对只展开一次，循环回指 / 多路径汇合经 visited 剪枝，不会重复搜索
  const order = new Map(analysis.articles.map((a, i) => [a.id, i] as const));
  const visited = new Set<string>([sourceId]);
  const parent = new Map<string, { article: string; edge: (typeof analysis.edges)[number] }>();
  let frontier = [sourceId];
  let found = false;
  while (frontier.length > 0 && !found) {
    const next: string[] = [];
    for (const from of frontier) {
      const row = adjacency.get(from);
      if (row) {
        // 同一层内按目标条文档顺序展开，保证存在多条最短路径时结果确定且符合阅读顺序
        const candidates = [...row.entries()].sort(
          (a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0),
        );
        for (const [to, edge] of candidates) {
          if (visited.has(to)) {
            prunedEdges += 1; // 循环回指或更短路径已到达的汇合点：剪枝
            continue;
          }
          visited.add(to);
          parent.set(to, { article: from, edge });
          if (to === targetId) {
            found = true;
            break;
          }
          next.push(to);
        }
      }
      if (found) break;
    }
    frontier = next;
  }

  if (!found) return null;

  // 回溯边链（终点 → 起点），再反转为来源 → 目标
  const chain: { article: string; edge: (typeof analysis.edges)[number] }[] = [];
  let cursor = targetId;
  while (cursor !== sourceId) {
    const link = parent.get(cursor)!;
    chain.push(link);
    cursor = link.article;
  }
  chain.reverse();

  const path: RefPathHop[] = chain.map(({ article: from, edge }) => {
    const occ = analysis.occurrences.find((o) => o.key === edge.refKey);
    const node = analysis.nodes[edge.sourceNodeId];
    const text = node?.text ?? '';
    const start = occ?.span.start ?? 0;
    const end = occ?.span.end ?? text.length;
    const sentence = locateSentence(text, start, end);
    const placement = analysis.placement[edge.sourceNodeId];
    return {
      fromArticleId: from,
      toArticleId: edge.targetArticleId,
      sourceNodeId: edge.sourceNodeId,
      refKey: edge.refKey,
      raw: occ?.span.raw ?? '',
      refStart: start,
      refEnd: end,
      sentenceStart: sentence.start,
      sentenceEnd: sentence.end,
      sourceLabel: placement ? placementLabel(placement) : '',
      partlyBroken: edge.status === 'broken',
      fromAmbiguityConfirmed: Boolean(occ?.resolution.ambiguity),
      inCycle: cycleSet.has(edge.targetArticleId),
    };
  });

  return { sourceId, targetId, hops: path.length, path, prunedEdges };
}
