"""
Move this deployment's files from Cloudflare R2 to Azure Blob — run once on
the Azure VM, inside the api container, after AZURE_STORAGE_ACCOUNT /
AZURE_STORAGE_CONTAINER are in .env and the VM's managed identity has
"Storage Blob Data Contributor" on the container. R2_* must still be set (it
is read from, never written to or deleted from).

    docker compose exec api python -m api.migrate_storage            # dry run: counts only
    docker compose exec api python -m api.migrate_storage --apply    # copy + rewrite links

1. Copies every R2 object to Blob under the same key and content type
   (objects already in Blob with the same size are skipped, so it can be
   re-run — e.g. once more right before switching, to pick up late uploads).
2. Rewrites every stored link: each text / json column in the database that
   contains R2_PUBLIC_URL + "/" gets it replaced by the Blob base
   (PUBLIC_BASE_URL + "/api/files", or FILES_PUBLIC_URL).

Until step 2 runs, old links still work: on Blob, _store_key() maps an R2
link to the same key. Only this deployment's database is touched — the
Vercel deployment has its own database and keeps using R2.
"""
import argparse
import sys

import api.index as index


def _blob_sizes() -> dict:
    return {b.name: b.size for b in index._blob().list_blobs()}


def copy_objects(apply: bool) -> None:
    from azure.storage.blob import ContentSettings
    r2 = index._r2()
    have = _blob_sizes()
    pages = r2.get_paginator("list_objects_v2").paginate(Bucket=index.R2_BUCKET_NAME)
    total = todo = copied = 0
    failed = []
    for page in pages:
        for obj in page.get("Contents") or []:
            key, size = obj["Key"], obj["Size"]
            total += 1
            if have.get(key) == size:
                continue
            todo += 1
            if not apply:
                continue
            try:
                got = r2.get_object(Bucket=index.R2_BUCKET_NAME, Key=key)
                index._blob().upload_blob(
                    key, got["Body"].read(), overwrite=True,
                    content_settings=ContentSettings(
                        content_type=got.get("ContentType") or "application/octet-stream"))
                copied += 1
                if copied % 100 == 0:
                    print(f"  …已複製 {copied} / {todo}", flush=True)
            except Exception as e:      # keep going; report at the end
                failed.append(f"{key}: {e}")
    print(f"R2 物件 {total} 個，需要複製 {todo} 個" + (f"，已複製 {copied} 個" if apply else "（預覽，未複製）"))
    for f in failed:
        print("  複製失敗：" + f)
    if failed:
        sys.exit("有檔案複製失敗，沒有改寫資料庫連結。請排除後重跑。")


def rewrite_links(apply: bool) -> None:
    old, new = index.R2_PUBLIC_URL + "/", index._files_base() + "/"
    with index.get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT table_name, column_name, data_type FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND data_type IN ('text', 'character varying', 'json', 'jsonb')
                   AND table_name <> 'alembic_version'
                 ORDER BY table_name, column_name
            """)
            columns = cur.fetchall()
            total = 0
            for table, column, dtype in columns:
                cast = {"character varying": "text"}.get(dtype, dtype)
                where = f'strpos("{column}"::text, %s) > 0'
                if apply:
                    cur.execute(f'UPDATE "{table}" SET "{column}" = '
                                f'replace("{column}"::text, %s, %s)::{cast} WHERE {where}', (old, new, old))
                    n = cur.rowcount
                else:
                    cur.execute(f'SELECT count(*) FROM "{table}" WHERE {where}', (old,))
                    n = cur.fetchone()[0]
                if n:
                    print(f"  {table}.{column}：{n} 筆")
                    total += n
            if not apply:
                conn.rollback()
    print(f"資料庫連結 {old} → {new}：{total} 筆" + ("已改寫" if apply else "（預覽，未改寫）"))


def main() -> None:
    ap = argparse.ArgumentParser(description="把檔案從 R2 搬到 Azure Blob，並改寫資料庫裡的連結")
    ap.add_argument("--apply", action="store_true", help="真的複製與改寫（不加只預覽）")
    ap.add_argument("--skip-copy", action="store_true", help="只改寫連結（檔案已經複製過）")
    args = ap.parse_args()

    if not index._blob_mode():
        sys.exit("AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_CONTAINER 沒有設定")
    if not (index.R2_PUBLIC_URL and index.R2_BUCKET_NAME):
        sys.exit("R2_* 沒有設定，無從搬起")
    if not index._files_base():
        sys.exit("PUBLIC_BASE_URL（或 FILES_PUBLIC_URL）沒有設定，不知道新連結要寫成什麼")
    print(f"R2 {index.R2_BUCKET_NAME} → Blob {index.AZURE_STORAGE_ACCOUNT}/{index.AZURE_STORAGE_CONTAINER}")
    if not args.skip_copy:
        copy_objects(args.apply)
    rewrite_links(args.apply)


if __name__ == "__main__":
    main()
