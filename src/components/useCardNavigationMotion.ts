import { useLayoutEffect, useRef, type RefObject } from "react";
import { uiTokens } from "../styles/tokens";

interface Point {
  x: number;
  y: number;
}

interface CardPosition extends Point {
  cardId: string;
}

export function useCardNavigationMotion(
  stageRef: RefObject<HTMLDivElement | null>,
  documentId: string,
  viewMode: string,
  activeId: string | null,
  positions: CardPosition[],
  pan: Point,
  overviewConnectorsRef: RefObject<SVGSVGElement | null>,
) {
  const previous = useRef<{
    documentId: string;
    viewMode: string;
    activeId: string;
    positions: Map<string, Point>;
    pan: Point;
  } | null>(null);
  const running = useRef(new Map<string | null, { animation: Animation; offset: Point }>());

  useLayoutEffect(() => {
    const before = previous.current;
    const currentPositions = new Map(positions.map((card) => [card.cardId, card]));
    previous.current = activeId ? { documentId, viewMode, activeId, positions: currentPositions, pan } : null;

    const sameTree = activeId && before?.documentId === documentId && before.viewMode === viewMode;
    if (sameTree && before.activeId === activeId) return;

    const interrupted = running.current;
    running.current = new Map();
    const stage = stageRef.current;
    if (sameTree && stage && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const slide = (element: Element, cardId: string, motionId: string | null = cardId) => {
        const from = before.positions.get(cardId);
        const to = currentPositions.get(cardId);
        if (!from || !to || !element.animate) return;

        // Start at the card's current visual position when another key arrives mid-slide.
        const prior = interrupted.get(motionId);
        const progress = prior?.animation.effect?.getComputedTiming().progress ?? 1;
        // A selection recenters pan before paint, so the destination is unpanned.
        const x = from.x + before.pan.x - to.x + (prior?.offset.x ?? 0) * (1 - progress);
        const y = from.y + before.pan.y - to.y + (prior?.offset.y ?? 0) * (1 - progress);
        if (x === 0 && y === 0) return;

        const animation = element.animate(
          [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }],
          { duration: uiTokens.cardNavigationMs, easing: uiTokens.animationEasing },
        );
        running.current.set(motionId, { animation, offset: { x, y } });
      };

      // Wide Lens uses the same translation for every card and its connector layer.
      if (overviewConnectorsRef.current) slide(overviewConnectorsRef.current, activeId, null);
      stage.querySelectorAll<HTMLElement>("[data-appearance-id]").forEach((card) => {
        slide(card, card.dataset.appearanceId!);
      });
    }
    interrupted.forEach(({ animation }) => animation.cancel());
  });

  useLayoutEffect(() => () => {
    running.current.forEach(({ animation }) => animation.cancel());
    running.current.clear();
  }, []);
}
