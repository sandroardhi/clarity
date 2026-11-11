import * as visualize from "@src/clarity";
import { Visualizer } from "@src/visualizer";

// Expose the visualizer under the tracker global, which does not collide with Microsoft Clarity's window.clarity
if (typeof window !== "undefined") {
    const w = window as any;
    if (w.skalplHeatmap === undefined || w.skalplHeatmap === null) {
        w.skalplHeatmap = {};
    }
    w.skalplHeatmap.visualize = visualize;
    w.clarityVisualize = visualize;
    w.Visualizer = Visualizer;
}
