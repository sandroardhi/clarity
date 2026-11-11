import * as visualize from "@src/clarity";
import { Visualizer } from "@src/visualizer";

// Expose clarity variable globally to allow access to public interface in a browser
if (typeof window !== "undefined") {
    const w = window as any;
    if (w.clarity === undefined || w.clarity === null) {
        w.clarity = {};
    }
    w.clarity.visualize = visualize;
    w.clarityVisualize = visualize;
    w.Visualizer = Visualizer;
}
