// The reusable test library. Each template is app-independent:
//   spec        action → expected network → expected state change → persists on reload?
//   appliesTo   (element, ctx) → bool        which elements it can test
//   run         (ctx, element) → { checks, primary, persistsOnReload } | { skipped }
//   requires    [] | ["credentials"] | ["mutations"]   stateful tests are opt-in
//   followUpOf  planned whenever that template is (update/delete after create)
//   judge       a passing result is also reviewed by the LLM for logic errors
import pageHealth from "./pageHealth.js";
import brokenImages from "./brokenImages.js";
import accessibility from "./accessibility.js";
import storageSecurity from "./storageSecurity.js";
import performance from "./performance.js";
import responsive from "./responsive.js";
import apiFailure from "./apiFailure.js";
import crossBrowser from "./crossBrowser.js";
import securityHeaders from "./securityHeaders.js";
import seoMeta from "./seoMeta.js";
import notFound from "./notFound.js";
import linkChecker from "./linkChecker.js";
import navLink from "./navLink.js";
import backButton from "./backButton.js";
import genericClick from "./genericClick.js";
import formValidation from "./formValidation.js";
import invalidInput from "./invalidInput.js";
import serverValidation from "./serverValidation.js";
import multiStep from "./multiStep.js";
import doubleSubmit from "./doubleSubmit.js";
import search from "./search.js";
import upload from "./upload.js";
import { invalidLogin, validLogin } from "./auth.js";
import { createItem, deleteItem, updateItem } from "./crud.js";
import cart from "./cart.js";

export const PAGE_TEMPLATES = [
  pageHealth,
  brokenImages,
  accessibility,
  storageSecurity,
  performance,
  responsive,
  apiFailure,
  crossBrowser,
  securityHeaders,
  seoMeta,
  notFound,
  linkChecker,
];

// Order matters: create-item, then update-item, then delete-item (which only
// touch the item create-item made).
export const ELEMENT_TEMPLATES = [
  search,
  invalidLogin,
  validLogin,
  formValidation,
  invalidInput,
  serverValidation,
  multiStep,
  doubleSubmit,
  createItem,
  cart,
  upload,
  navLink,
  backButton,
  genericClick,
  updateItem,
  deleteItem,
];

export const ALL_TEMPLATES = [...PAGE_TEMPLATES, ...ELEMENT_TEMPLATES];
