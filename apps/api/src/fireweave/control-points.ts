// Every control point this app reads, with its LOCAL value.
// Production values come from FireWeave rollouts, never from this file.
import { defineControlPoints } from '@fireweaveai/server-sdk/start';

export const controlPoints = defineControlPoints({
  // Test control points for FireWeave's ramping flow (docs/fireweave-testbed.md). Each is a harmless read.
  'lay-manual-1': { local: true },
});
