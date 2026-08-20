/**
 * Vite does not resolve EUI's dynamic icon imports the same way Webpack does.
 * Pre-register icons used by the shell (and a few common ones) so iconType works.
 */
import { appendIconComponentCache } from "@elastic/eui/es/components/icon/icon";
import { icon as check } from "@elastic/eui/es/components/icon/assets/check";
import { icon as cross } from "@elastic/eui/es/components/icon/assets/cross";
import { icon as empty } from "@elastic/eui/es/components/icon/assets/empty";
import { icon as logoElastic } from "@elastic/eui/es/components/icon/assets/logo_elastic";
import { icon as popout } from "@elastic/eui/es/components/icon/assets/popout";
import { icon as refresh } from "@elastic/eui/es/components/icon/assets/refresh";
import { icon as warning } from "@elastic/eui/es/components/icon/assets/warning";

appendIconComponentCache({
  check,
  cross,
  empty,
  logoElastic,
  popout,
  refresh,
  warning,
});
