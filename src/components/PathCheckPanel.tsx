import { useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { useHighlighter } from '../lib/highlighter';
import { shortArticleLabel } from '../lib/labels';
import { findRefPath, type RefPathHop } from '../lib/pathcheck';

/**
 * 引用路径核对（放在关系视图旁）：选起点条与终点条后，
 * 基于当前已确认的条级引用边展示一条跳数最少的有向路径。
 * 结果随 analysis（正文编辑 / 歧义确认均会重建解析图）即时重算，
 * 不缓存任何旧证据；纯会话内计算，不修改正文、不进入撤销历史。
 */
export function PathCheckPanel() {
  const { store, highlighter } = useApp();
  const hl = useHighlighter(highlighter);
  const { analysis } = store.getSnapshot();

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');

  const articles = analysis.articles;
  const source = sourceId ? analysis.nodes[sourceId] : undefined;
  const target = targetId ? analysis.nodes[targetId] : undefined;
  const bothChosen = Boolean(sourceId && targetId);

  // 随解析图实时重算：正文或歧义确认变化即 analysis 重建，旧路径 / 旧证据不会被展示
  const report = useMemo(
    () => (bothChosen ? findRefPath(analysis, sourceId, targetId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analysis, sourceId, targetId],
  );

  const clearAll = () => {
    setSourceId('');
    setTargetId('');
  };

  return (
    <div className="path-panel">
      <div className="path-head">
        <span className="impact-title">引用路径核对</span>
        <button className="small" onClick={clearAll} disabled={!sourceId && !targetId}>
          清空选择
        </button>
      </div>
      <div className="path-form">
        <select
          className="impact-select"
          value={source ? sourceId : ''}
          onChange={(e) => setSourceId(e.target.value)}
          aria-label="选择路径起点条款"
        >
          <option value="">起点条…</option>
          {articles.map((a) => (
            <option key={a.id} value={a.id}>
              {shortArticleLabel(a.ordinal, a.suffix)}
              {a.title ? ` ${a.title}` : ''}
            </option>
          ))}
          {sourceId && !source && <option value={sourceId}>（已删除的条款）</option>}
        </select>
        <span className="path-arrow" aria-hidden>
          →
        </span>
        <select
          className="impact-select"
          value={target ? targetId : ''}
          onChange={(e) => setTargetId(e.target.value)}
          aria-label="选择路径终点条款"
        >
          <option value="">终点条…</option>
          {articles.map((a) => (
            <option key={a.id} value={a.id}>
              {shortArticleLabel(a.ordinal, a.suffix)}
              {a.title ? ` ${a.title}` : ''}
            </option>
          ))}
          {targetId && !target && <option value={targetId}>（已删除的条款）</option>}
        </select>
      </div>

      {!bothChosen && (
        <div className="impact-hint">
          选择起点条与终点条，基于当前已确认的条级引用边找一条跳数最少的有向路径；
          组合引用的每个已解析目标各算一条边，未确认的歧义引用不参与。
        </div>
      )}

      {bothChosen && (!source || !target) && (
        <div className="impact-stale">所选条款已从文档删除，请重新选择起点条与终点条。</div>
      )}

      {bothChosen && source && target && sourceId === targetId && (
        <div className="path-result">
          <div className="path-summary">
            起点与终点为同一条（
            <strong>{shortArticleLabel(source.ordinal, source.suffix)}</strong>），路径为 0 跳。
          </div>
        </div>
      )}

      {bothChosen && source && target && sourceId !== targetId && !report && (
        <div className="path-result">
          <div className="path-none">
            从
            <strong>
              {shortArticleLabel(source.ordinal, source.suffix)}
              {source.title ? `【${source.title}】` : ''}
            </strong>
            到
            <strong>
              {shortArticleLabel(target.ordinal, target.suffix)}
              {target.title ? `【${target.title}】` : ''}
            </strong>
            不存在沿当前已确认引用关系的有向路径。
          </div>
          <div className="impact-hint">
            未确认的歧义引用不计入边；可先在「问题与引用」中确认歧义后再核对。
          </div>
        </div>
      )}

      {report && report.hops > 0 && source && target && (
        <div className="path-result">
          <div className="path-summary">
            {shortArticleLabel(source.ordinal, source.suffix)} →{' '}
            {shortArticleLabel(target.ordinal, target.suffix)}：最少{' '}
            <strong>{report.hops}</strong> 跳
            {report.prunedEdges > 0 ? `（循环 / 重复边已剪枝 ${report.prunedEdges} 条）` : ''}
          </div>
          <ol className="path-hops">
            {report.path.map((hop, idx) => (
              <PathHopRow
                key={`${hop.refKey}:${idx}`}
                hop={hop}
                index={idx + 1}
                hot={hl.hoverRefKey === hop.refKey || hl.activeRefKey === hop.refKey}
                onHover={(on) =>
                  on
                    ? highlighter.hoverRef(hop.refKey, [hop.toArticleId])
                    : highlighter.hoverRef(null, null)
                }
                onJumpSentence={() =>
                  highlighter.jumpTo(
                    hop.sourceNodeId,
                    { start: hop.sentenceStart, end: hop.sentenceEnd },
                    hop.refKey,
                  )
                }
                onJumpArticle={(id) => highlighter.jumpTo(id)}
              />
            ))}
          </ol>
          <div className="impact-note">
            逐跳展示来源条、引用原句与目标条；点击来源句定位正文。结果基于当前确认后的解析图，
            正文或歧义确认变化时自动重算，仅用于当前会话，不修改正文、不写入撤销历史。
          </div>
        </div>
      )}
    </div>
  );
}

function PathHopRow({
  hop,
  index,
  hot,
  onHover,
  onJumpSentence,
  onJumpArticle,
}: {
  hop: RefPathHop;
  index: number;
  hot: boolean;
  onHover: (on: boolean) => void;
  onJumpSentence: () => void;
  onJumpArticle: (id: string) => void;
}) {
  const { analysis } = useApp().store.getSnapshot();
  const sourceNode = analysis.nodes[hop.sourceNodeId];
  const sourceArticle = analysis.articles.find((a) => a.id === hop.fromArticleId);
  const targetArticle = analysis.articles.find((a) => a.id === hop.toArticleId);
  const text = sourceNode?.text ?? '';

  // 来源句中拆分「句前文字 / 引用原文 / 句后文字」，引用部分高亮
  const relStart = hop.refStart - hop.sentenceStart;
  const relEnd = hop.refEnd - hop.sentenceStart;
  const sentence = text.slice(hop.sentenceStart, hop.sentenceEnd);
  const before = sentence.slice(0, Math.max(0, relStart));
  const quoted = sentence.slice(Math.max(0, relStart), Math.max(0, relEnd));
  const after = sentence.slice(Math.max(0, relEnd));

  return (
    <li className={`path-hop ${hot ? 'hot' : ''}`} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="path-hop-head">
        <span className="path-hop-index">第 {index} 跳</span>
        <button
          className="path-hop-article"
          onClick={() => onJumpArticle(hop.fromArticleId)}
          title="点击定位正文来源条"
        >
          {sourceArticle ? shortArticleLabel(sourceArticle.ordinal, sourceArticle.suffix) : '（已删除）'}
        </button>
        <span className="path-hop-via">于</span>
        <span className="path-hop-source-label">{hop.sourceLabel}</span>
        <span className="path-hop-via">引用</span>
        <button
          className="path-hop-target"
          onClick={() => onJumpArticle(hop.toArticleId)}
          title="点击定位正文目标条"
        >
          {targetArticle ? shortArticleLabel(targetArticle.ordinal, targetArticle.suffix) : '（已删除）'}
        </button>
        {hop.inCycle && <span className="path-cycle-badge">↻ 循环</span>}
      </div>
      <button
        className="path-sentence"
        onClick={onJumpSentence}
        title="点击定位到正文来源句"
      >
        {before}
        <mark className="path-ref">{quoted || hop.raw}</mark>
        {after}
      </button>
      <div className="path-hop-flags">
        {hop.partlyBroken && <span className="path-flag is-broken">该组合引用含未解析目标（此边为已解析目标）</span>}
        {hop.fromAmbiguityConfirmed && <span className="path-flag is-confirmed">歧义已确认</span>}
      </div>
    </li>
  );
}
