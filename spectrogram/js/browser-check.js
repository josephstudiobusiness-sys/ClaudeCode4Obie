(function () {
  var ua = navigator.userAgent;
  // Both Chrome and Edge contain "Chrome/" in the UA string; Opera adds "OPR/"
  var isChromiumBased = /Chrome\//.test(ua) && !/OPR\//.test(ua);
  if (!isChromiumBased) {
    alert(
      'You are not using Chrome or Edge.\n\n' +
      'Saving data to your hard drive requires the File System Access API, ' +
      'which is only available in Chrome or Edge. ' +
      'Please switch browsers if you need to save files locally.'
    );
  }
})();
