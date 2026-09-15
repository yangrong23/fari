(function () {
  "use strict";

  const config = {
    metaPixelId: "",
    googleTagId: "",
    googleConversionId: "",
    googlePurchaseLabel: "",
    tiktokPixelId: ""
  };

  function loadScript(src) {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }

  function initMetaPixel(pixelId) {
    if (!pixelId || window.fbq) return;
    window.fbq = function () {
      window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments);
    };
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = "2.0";
    window.fbq.queue = [];
    loadScript("https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", pixelId);
    window.fbq("track", "PageView");
  }

  function initGoogleTag(tagId) {
    if (!tagId) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", tagId);
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tagId)}`);
  }

  function initTikTokPixel(pixelId) {
    if (!pixelId || window.ttq) return;
    window.TiktokAnalyticsObject = "ttq";
    const ttq = window.ttq = window.ttq || [];
    ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
    ttq.setAndDefer = function (target, method) {
      target[method] = function () {
        target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    for (let i = 0; i < ttq.methods.length; i += 1) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function (id) {
      const instance = ttq._i[id] || [];
      for (let i = 0; i < ttq.methods.length; i += 1) ttq.setAndDefer(instance, ttq.methods[i]);
      return instance;
    };
    ttq.load = function (id) {
      ttq._i = ttq._i || {};
      ttq._i[id] = [];
      ttq._i[id]._u = "https://analytics.tiktok.com/i18n/pixel/events.js";
      loadScript(ttq._i[id]._u);
    };
    ttq.load(pixelId);
    ttq.page();
  }

  function trackPurchase(value, currency) {
    const amount = Number(value || 9.9);
    const unit = currency || "USD";
    if (window.fbq) window.fbq("track", "Purchase", { value: amount, currency: unit });
    if (window.ttq?.track) window.ttq.track("CompletePayment", { value: amount, currency: unit });
    if (window.gtag && config.googleConversionId && config.googlePurchaseLabel) {
      window.gtag("event", "conversion", {
        send_to: `${config.googleConversionId}/${config.googlePurchaseLabel}`,
        value: amount,
        currency: unit
      });
    }
  }

  window.fariTrack = function (eventName, payload) {
    const data = payload || {};
    if (eventName === "purchase") {
      trackPurchase(data.value, data.currency);
      return;
    }
    if (window.fbq) window.fbq("trackCustom", eventName, data);
    if (window.ttq?.track) window.ttq.track(eventName, data);
    if (window.gtag) window.gtag("event", eventName, data);
  };

  window.fariTrackingConfig = config;
  initMetaPixel(config.metaPixelId);
  initGoogleTag(config.googleTagId || config.googleConversionId);
  initTikTokPixel(config.tiktokPixelId);
})();
