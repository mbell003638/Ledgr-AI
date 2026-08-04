import {
  getEnabledFeatures,
  getPersonaBaselineFeatures,
  isFeatureEnabled,
  PERSONA_DEFAULT_FEATURES,
  ALL_FEATURES,
  type FeatureKey,
} from "../src/utils/featureFlags";

const ALL_KEYS = ALL_FEATURES.map((f) => f.key);

describe("persona → dashboard tiles mapping", () => {
  it("resolves the canonical PersonaId values written by onboarding/settings", () => {
    // These are the actual PersonaId values (src/accountingV2/config.ts) that
    // onboarding.tsx and settings.tsx persist. Each must have an explicit set.
    for (const id of [
      "retail",
      "wholesale",
      "salon",
      "handyman",
      "professional_service",
      "it_freelancer",
      "vendor",
      "custom",
    ]) {
      expect(PERSONA_DEFAULT_FEATURES[id]).toBeDefined();
      expect(PERSONA_DEFAULT_FEATURES[id].length).toBeGreaterThan(0);
    }
  });

  it("retail / wholesale / vendor personas get the full tile set (they hold stock)", () => {
    for (const persona of ["retail", "wholesale", "vendor"]) {
      const enabled = getEnabledFeatures({ activePersona: persona });
      expect(enabled).toEqual(ALL_KEYS);
      expect(enabled).toContain("inventory");
    }
  });

  it("pure service personas do NOT lead with inventory or supplier bills", () => {
    for (const persona of ["professional_service", "it_freelancer"]) {
      const enabled = getEnabledFeatures({ activePersona: persona });
      expect(enabled).not.toContain("inventory");
      expect(enabled).not.toContain("bills");
      expect(enabled).not.toContain("delivery");
      // still invoice-driven
      expect(enabled).toContain("invoices");
      expect(enabled).toContain("receipts");
    }
  });

  it("salon is cash + service (no inventory), handyman buys materials (bills) but no shelf stock", () => {
    const salon = getEnabledFeatures({ activePersona: "salon" });
    expect(salon).not.toContain("inventory");
    expect(salon).toContain("sales");

    const handyman = getEnabledFeatures({ activePersona: "handyman" });
    expect(handyman).not.toContain("inventory");
    expect(handyman).toContain("bills");
    expect(handyman).toContain("invoices");
  });

  it("falls back to the full set for an unknown persona", () => {
    expect(getEnabledFeatures({ activePersona: "nonsense" })).toEqual(ALL_KEYS);
    expect(getEnabledFeatures({})).toEqual(ALL_KEYS);
  });

  describe("legacy businessType aliases", () => {
    it("older settings that only wrote businessType still resolve sensibly", () => {
      expect(getEnabledFeatures({ businessType: "shop" })).toEqual(ALL_KEYS);
      const service = getEnabledFeatures({ businessType: "service" });
      expect(service).not.toContain("inventory");
      expect(service).toContain("invoices");
    });
  });

  describe("multi-persona union", () => {
    it("unions the feature sets of every selected persona", () => {
      // professional_service (no inventory) ∪ retail (everything) === everything
      const enabled = getEnabledFeatures({
        selectedPersonas: ["professional_service", "retail"],
      });
      expect(enabled).toEqual(ALL_KEYS);
      expect(enabled).toContain("inventory"); // contributed by retail
    });

    it("a union of two service personas stays free of stock tiles", () => {
      const enabled = getEnabledFeatures({
        selectedPersonas: ["professional_service", "it_freelancer"],
      });
      expect(enabled).not.toContain("inventory");
      expect(enabled).not.toContain("bills");
      expect(enabled).toContain("invoices");
    });

    it("preserves the canonical ALL_FEATURES ordering in the union", () => {
      const enabled = getPersonaBaselineFeatures({
        selectedPersonas: ["salon", "handyman"],
      });
      const orderInAll = enabled.map((k) => ALL_KEYS.indexOf(k as FeatureKey));
      const sorted = [...orderInAll].sort((a, b) => a - b);
      expect(orderInAll).toEqual(sorted);
    });

    it("selectedPersonas takes precedence over a lone activePersona", () => {
      // selectedPersonas union should win over activePersona when both present.
      const enabled = getEnabledFeatures({
        activePersona: "professional_service",
        selectedPersonas: ["retail"],
      });
      expect(enabled).toContain("inventory");
    });
  });

  describe("manual override precedence", () => {
    it("explicit enabledFeatures overrides the persona baseline", () => {
      const custom: FeatureKey[] = ["sales", "reports"];
      const enabled = getEnabledFeatures({
        activePersona: "retail", // baseline would be everything
        selectedPersonas: ["retail"],
        enabledFeatures: custom,
      });
      expect(enabled).toEqual(custom);
      expect(isFeatureEnabled({ enabledFeatures: custom }, "inventory")).toBe(false);
      expect(isFeatureEnabled({ enabledFeatures: custom }, "sales")).toBe(true);
    });

    it("an empty enabledFeatures array is ignored and falls back to the persona baseline", () => {
      const enabled = getEnabledFeatures({ activePersona: "salon", enabledFeatures: [] });
      // Baseline is order-normalized to the canonical ALL_FEATURES ordering,
      // so compare as sets against the salon default.
      expect(new Set(enabled)).toEqual(new Set(PERSONA_DEFAULT_FEATURES.salon));
    });
  });
});
