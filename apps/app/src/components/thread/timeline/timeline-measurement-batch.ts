import { createContext } from "react";

export type TimelineMeasurement = () => () => void;

export const TimelineMeasurementBatchContext = createContext<
  ((measure: TimelineMeasurement) => () => void) | null
>(null);
