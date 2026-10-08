自己ホストしている外部ライブラリ(バーコード読み取り用)
- barcode-detector 3.2.2 の dist/iife/polyfill.js
  (wasmの取得先だけ、CDNではなくこのフォルダを指すよう1行書き換え済み)
- zxing-wasm 3.1.3 の zxing_reader.wasm
どちらもnpmで公開されている版をそのまま使用。更新する場合は手動で差し替える。
