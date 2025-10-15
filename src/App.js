import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import pako from 'pako'; // <-- add this
import './App.css';

function App() {
  const [text, setText] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState('');
  const [lastFile, setLastFile] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleParse = (inputText = text) => {
    try {
      const parsed = JSON.parse(inputText);
      setData(parsed);
      setError(null);
    } catch (e) {
      setData(null);
      setError(e.message);
    }
  };

  // BGZF-aware decompressor fallback + DecompressionStream + pako attempts
  const decompressGzipBuffer = async (arrayBuffer) => {
    const uint8 = new Uint8Array(arrayBuffer);
    // quick check for gzip magic
    if (!(uint8 && uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b)) {
      // not gzipped - return text directly
      return new TextDecoder().decode(arrayBuffer);
    }

    // 1) try browser native DecompressionStream (most modern browsers)
    if (typeof DecompressionStream === 'function') {
      try {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = new Response(new Blob([arrayBuffer]).stream().pipeThrough(ds));
        return await decompressedStream.text();
      } catch (e) {
        // fall through to pako/bgzf
        // eslint-disable-next-line no-console
        console.debug('DecompressionStream failed, falling back to pako/bgzf:', e);
      }
    }

    // 2) try pako ungzip/inflate (whole buffer)
    try {
      return pako.ungzip(uint8, { to: 'string' });
    } catch (e1) {
      try {
        return pako.inflate(uint8, { to: 'string' });
      } catch (e2) {
        // continue to BGZF-block parser fallback
        // eslint-disable-next-line no-console
        console.debug('pako whole-file attempts failed, trying BGZF-block parsing:', e1, e2);
      }
    }

    // 3) BGZF block-wise decompression (handles bgzip / concatenated members)
    const decompressBgzf = (u8) => {
      let pos = 0;
      const parts = [];
      while (pos < u8.length) {
        // require gzip magic
        if (u8[pos] !== 0x1f || u8[pos + 1] !== 0x8b) {
          throw new Error(`BGZF parsing: invalid gzip magic at ${pos}`);
        }
        if (pos + 10 > u8.length) throw new Error('BGZF parsing: truncated header');

        const FLG = u8[pos + 3];
        let idx = pos + 10; // after fixed header
        // skip optional fields until start of compressed data
        if (FLG & 0x04) { // FEXTRA present
          if (idx + 2 > u8.length) throw new Error('BGZF parsing: missing XLEN');
          const xlen = u8[idx] | (u8[idx + 1] << 8);
          idx += 2;
          if (idx + xlen > u8.length) throw new Error('BGZF parsing: truncated extra field');
          // parse subfields for 'BC' (BGZF)
          let subIdx = idx;
          let bsize = null;
          const extraEnd = idx + xlen;
          while (subIdx + 4 <= extraEnd) {
            const si1 = u8[subIdx], si2 = u8[subIdx + 1];
            const slen = u8[subIdx + 2] | (u8[subIdx + 3] << 8);
            const sdataIdx = subIdx + 4;
            if (sdataIdx + slen > extraEnd) break;
            if (si1 === 0x42 && si2 === 0x43 && slen >= 2) { // 'B','C'
              bsize = u8[sdataIdx] | (u8[sdataIdx + 1] << 8); // little-endian
              break;
            }
            subIdx = sdataIdx + slen;
          }
          if (bsize == null) {
            // Not BGZF extra field present; fall back to ungzip remaining bytes as single member
            const rem = u8.subarray(pos);
            try {
              return parts.concat([pako.ungzip(rem, { to: 'string' })]).join('');
            } catch (err) {
              throw new Error('BGZF parsing: missing BC field and ungzip failed: ' + err.message);
            }
          }
          const blockTotal = bsize + 1; // per BGZF spec
          const end = pos + blockTotal;
          if (end > u8.length) throw new Error('BGZF parsing: truncated block');
          const block = u8.subarray(pos, end);
          // decompress this single gzip member
          const dec = pako.ungzip(block, { to: 'string' });
          parts.push(dec);
          pos = end;
        } else {
          // no extra field: try to ungzip remaining bytes as single gzip member
          const rem = u8.subarray(pos);
          const dec = pako.ungzip(rem, { to: 'string' });
          parts.push(dec);
          break;
        }
      }
      return parts.join('');
    };

    try {
      return decompressBgzf(uint8);
    } catch (bgzfErr) {
      // eslint-disable-next-line no-console
      console.error('BGZF fallback failed', bgzfErr);
      throw new Error(`decompress failed: ${bgzfErr.message}`);
    }
  };

  // new: convert an uploaded .gz (or plain .json) File to a downloadable .json file
  const convertGzToJson = (file = lastFile) => {
    if (!file) return;
    const reader = new FileReader();
    const isGz = /\.gz$/i.test(file.name) || file.type === 'application/gzip';

    setLoading(true);
    reader.onload = async (evt) => {
      try {
        let content = '';
        if (isGz || evt.target.result instanceof ArrayBuffer) {
          content = await decompressGzipBuffer(evt.target.result);
        } else {
          content = String(evt.target.result || '');
        }

        // create downloadable blob and trigger save
        const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const outName = String(file.name).replace(/\.gz$/i, '') || 'export.json';
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setLoading(false);
      } catch (err) {
        setError('Failed to convert file: ' + (err.message || err));
        // eslint-disable-next-line no-console
        console.error('convertGzToJson error', err);
        setLoading(false);
      }
    };

    reader.onerror = () => setError('Failed to read file for conversion');
    // always read as ArrayBuffer so we can detect/compress reliably
    reader.readAsArrayBuffer(file);
  };

  const handleClear = () => {
    setText('');
    setData(null);
    setError(null);
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // accept only .json or .json.gz (case-insensitive). Reject plain .gz or other extensions.
    const name = String(file.name || '');
    const isJson = /\.json$/i.test(name);
    const isJsonGz = /\.json\.gz$/i.test(name);
    if (!isJson && !isJsonGz) {
      setError('Please select a .json or .json.gz file');
      setLastFile(null);
      return;
    }
    setError(null);
    setLastFile(file);
    const reader = new FileReader();
    const isGz = /\.gz$/i.test(file.name) || file.type === 'application/gzip';
    setLoading(true);

    reader.onload = async (evt) => {
      try {
        let content = '';
        if (isGz || evt.target.result instanceof ArrayBuffer) {
          // use centralized async decompressor
          content = await decompressGzipBuffer(evt.target.result);
        } else {
          content = String(evt.target.result || '');
        }
        setText(content);
        handleParse(content);
        setFileName(file.name || '');
        setLoading(false);
      } catch (err) {
        // clearer guidance for BGZF/corrupt files
        setError('Failed to read/decompress file: ' + (err.message || err) + '. File may be corrupt or in a BGZF/other gzip variant.');
        // eslint-disable-next-line no-console
        console.error('Decompress error', err);
        setLoading(false);
      }
    };

    reader.onerror = () => {
      setLoading(false);
      setError('Failed to read file');
    };

    if (isGz) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  };

  // changed code: generalized table renderer for various JSON shapes
  const normalizeToTable = (value) => {
    // helper: normalize numeric-keyed objects to arrays
    const toArray = (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object') return Object.values(v);
      return [v];
    };

    // format primitive/array-of-primitives values, return null for complex objects/arrays-of-objects
    const formatVal = (val) => {
      if (val == null) return null;
      if (Array.isArray(val)) {
        if (val.some(item => item !== null && typeof item === 'object')) return null;
        return val.join(', ');
      }
      if (typeof val === 'object') return null;
      return val;
    };

    const isComplex = (v) => {
      if (v == null) return false;
      if (Array.isArray(v)) return v.some(item => item !== null && typeof item === 'object');
      return typeof v === 'object';
    };

    // helper: skip date-like keys/values
    const isDateKey = (k) => typeof k === 'string' && /date/i.test(k);
    const isDateValue = (v) => {
      if (typeof v !== 'string') return false;
      // ISO-ish and common date patterns
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
        || /^\d{4}-\d{2}-\d{2}$/.test(v)
        || /^\d{2}\/\d{2}\/\d{4}$/.test(v)
        || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(v);
    };

    // sample field name mapping (prefer short names when single sample)
    const mapSampleFieldName = (sk, si, samplesCount) => {
      const keyNorm = String(sk).toLowerCase();
      // canonical base names for common sample fields
      const baseMap = {
        genotype: 'Genotype',
        variantfrequencies: 'Variant Frequency',
        variantfrequency: 'Variant Frequency',
        totaldepth: 'Total Depth',
        genotypequality: 'Genotype Quality',
        alleledepths: 'Allele Depths',
        alleledepts: 'Allele Depths',
        allele_depths: 'Allele Depths'
      };
      const base = baseMap[keyNorm] ?? String(sk).trim();

      if (samplesCount === 1) {
        // single sample: don't prefix with "Sample 0"
        return base;
      }
      // multiple samples -> keep index to avoid collisions
      return `Sample ${si} ${base}`;
    };

    const isEmptyValue = (v) => {
      return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
    };

    // flatten allowed primitive/array fields from an object/array under a prefixed name into `out`
    // collectSet (optional): a Set to record created column names
    const flattenFields = (prefix, obj, out, collectSet) => {
      if (obj == null) return;

      // debug: log gene objects so we can see why flattening may fail
      if (String(prefix).toLowerCase().startsWith('gene')) {
        // eslint-disable-next-line no-console
        console.debug('[debug] flattenFields called for Gene prefix, obj=', obj);
      }

      // collect values per inner key when obj is an array of objects
      if (Array.isArray(obj)) {
        const collected = {}; // key -> Array<formatted>
        obj.forEach(item => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            Object.keys(item).forEach(k => {
              const formatted = formatVal(item[k]);
              if (formatted !== null && formatted !== undefined) {
                collected[k] = collected[k] || [];
                collected[k].push(formatted);
              }
            });
          }
        });
        Object.keys(collected).forEach(k => {
          const colName = `${prefix} ${String(k).trim()}`.trim();
          // dedupe values and join
          out[colName] = Array.from(new Set(collected[k])).join(', ');
          if (collectSet && typeof collectSet.add === 'function') collectSet.add(colName);
        });
        return;
      }

      // obj is plain object
      if (typeof obj === 'object') {
        Object.keys(obj).forEach(k => {
          const val = obj[k];
          const formatted = formatVal(val);
          if (formatted !== null && formatted !== undefined) {
            const col = `${prefix} ${String(k).trim()}`.trim();
            out[col] = formatted;
            if (collectSet && typeof collectSet.add === 'function') collectSet.add(col);
            return;
          }
          // if nested object one level deeper, try to pick primitive children
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            Object.keys(val).forEach(subk => {
              const subFormatted = formatVal(val[subk]);
              if (subFormatted !== null && subFormatted !== undefined) {
                const col = `${prefix} ${String(k).trim()} ${String(subk).trim()}`.trim();
                out[col] = subFormatted;
                if (collectSet && typeof collectSet.add === 'function') collectSet.add(col);
              }
            });
          }
        });
      }
    };

    // positions may be top-level or under rows/data/items
    let positionsSource = value.positions || value.rows || value.data || value.items || [];
    if (!Array.isArray(positionsSource) && positionsSource && typeof positionsSource === 'object') {
      positionsSource = Object.values(positionsSource);
    }
    const positions = toArray(positionsSource);

    // also support a top-level "genes" or "gene" collection that aligns with positions by index
    const topLevelGenes = toArray(value.genes ?? value.gene ?? []);
    // eslint-disable-next-line no-console
    if (topLevelGenes.length) console.debug('[debug] topLevelGenes length =', topLevelGenes.length);

    const rows = [];
    const transcriptKeySet = new Set();
    const sampleKeySet = new Set();
    const geneKeySet = new Set();
    const extraRows = []; // collect gene rows (appended after main rows)

    positions.forEach((pos, posIdx) => {
      const p = (pos && typeof pos === 'object') ? pos : {};
      // prefer explicit position-level genes, fall back to top-level genes by index
      const pGenes = p.genes ?? p.gene ?? topLevelGenes[posIdx] ?? null;
      let variants = p.variants ?? p.variant ?? [];
      if (!Array.isArray(variants) && variants && typeof variants === 'object') variants = Object.values(variants);
      variants = toArray(variants);

      const posAlts = toArray(p.altAllele ?? p.altAlleles ?? p.alts);

      variants.forEach((v, varIdx) => {
        const variant = (v && typeof v === 'object') ? v : {};
        let transcripts = variant.transcripts ?? variant.transcript ?? [];
        if (!Array.isArray(transcripts) && transcripts && typeof transcripts === 'object') transcripts = Object.values(transcripts);
        transcripts = toArray(transcripts);

        const varAlts = toArray(variant.altAllele ?? variant.altAlleles ?? variant.alts);
        const altSource = varAlts.length ? varAlts : posAlts;

        // helper to add variant-level primitive fields and flattened clinvar-like fields
        const addVariantLevelToOut = (variantObj, out) => {
          if (!variantObj || typeof variantObj !== 'object') return;
          Object.keys(variantObj).forEach(k => {
            // skip nested collections we handle elsewhere
            if (['transcripts', 'transcript', 'altAllele', 'altAlleles', 'alts'].includes(k)) return;

            const vval = variantObj[k];

            // 1) if primitive or array-of-primitives -> include directly as column "k"
            const formatted = formatVal(vval);
            if (formatted !== null && formatted !== undefined) {
              out[k] = formatted;
              return;
            }

            // 2) if object / array-of-objects -> try to flatten its primitive children
            //    flattenFields handles: array of objects (collect inner keys) or single object (one-level)
            if (vval && typeof vval === 'object') {
              const prefix = String(k).trim(); // e.g. "clinvar", "globalAllele", "cosmic"
              flattenFields(prefix, vval, out);
              return;
            }
            // otherwise skip (complex deeper nesting)
          });
        };

        if (transcripts.length === 0) {
          const alts = altSource.length ? altSource : [null];
          alts.forEach((alt, altIdx) => {
            const out = {};
            out['Chromosome'] = formatVal(p.chromosome ?? p.Chromosome ?? p.chromosomes ?? p.chr ?? null);
            out['Position'] = formatVal(p.position ?? p.Position ?? p.pos ?? null);
            out['Ref Allele'] = formatVal(p.refAllele ?? p.ref ?? variant.refAllele ?? variant.ref ?? null);
            out['Alt Allele'] = formatVal(alt ?? null);
            out['_position_index'] = posIdx;
            out['_variant_index'] = varIdx;
            out['_alt_index'] = altIdx;

            // flatten position-level samples -> put sample fields right after Chromosome/Position
            if (p.samples) {
              const samplesArr = Array.isArray(p.samples) ? p.samples : (typeof p.samples === 'object' ? Object.values(p.samples) : []);
              const samplesCount = samplesArr.length;
              samplesArr.forEach((s, si) => {
                if (s && typeof s === 'object') {
                  Object.keys(s).forEach(sk => {
                    // skip complex nested objects/arrays and date-like fields/values
                    if (isComplex(s[sk]) || isDateKey(sk) || isDateValue(s[sk])) return;
                    // handle arrays-of-primitives specially: for variant frequencies pick first element
                    let sval = s[sk];
                    if (Array.isArray(sval) && sval.every(item => item !== null && typeof item !== 'object')) {
                      const keyNorm = String(sk).toLowerCase();
                      if (keyNorm.includes('variantfrequency')) {
                        sval = sval.length ? sval[0] : null;
                      } else {
                        sval = sval.join(', ');
                      }
                    }
                    const formatted = formatVal(sval);
                    if (formatted !== null && formatted !== undefined) {
                      const col = mapSampleFieldName(sk, si, samplesCount);
                      // insert sample columns now so they appear early (do not overwrite)
                      if (out[col] === undefined) {
                        out[col] = formatted;
                        sampleKeySet.add(col); // remember sample column order separately
                      }
                    }
                  });
                }
              });
            }

            // include position primitive fields (do this after samples so samples appear earlier)
            Object.keys(p).forEach(k => {
              if (!(k in out) && !isComplex(p[k]) && !isDateKey(k) && !isDateValue(p[k])) out[k] = formatVal(p[k]);
            });

            // include variant primitive fields and flattened clinvar/clinvarPreview
            addVariantLevelToOut(variant, out);
            // (variant processed after samples to avoid overwriting sample columns)

            // flatten genes present at variant-level
            if (variant.genes) {
              const gArr = Array.isArray(variant.genes) ? variant.genes : [variant.genes];
              gArr.forEach(gobj => {
                const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx, _variant_index: varIdx };
                flattenFields('Gene', gobj, geneRow, geneKeySet);
                if (Object.keys(geneRow).length > 3) extraRows.push(geneRow);
              });
            }
            if (variant.gene) {
              const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx, _variant_index: varIdx };
              flattenFields('Gene', variant.gene, geneRow, geneKeySet);
              if (Object.keys(geneRow).length > 3) extraRows.push(geneRow);
            }
            if (pGenes) {
              const pgArr = Array.isArray(pGenes) ? pGenes : [pGenes];
              pgArr.forEach(gobj => {
                const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx };
                flattenFields('Gene', gobj, geneRow, geneKeySet);
                if (Object.keys(geneRow).length > 3) extraRows.push(geneRow);
              });
            }

            rows.push(out);
          });
        } else {
          transcripts.forEach((t, tIdx) => {
            const tr = (t && typeof t === 'object') ? t : {};
            Object.keys(tr).forEach(k => {
              if (!isComplex(tr[k])) transcriptKeySet.add(k);
            });
            const alts = altSource.length ? altSource : [null];
            alts.forEach((alt, altIdx) => {
              const out = {};
              out['Chromosome'] = formatVal(p.chromosome ?? p.Chromosome ?? p.chromosomes ?? p.chr ?? null);
              out['Position'] = formatVal(p.position ?? p.Position ?? p.pos ?? null);
              out['Ref Allele'] = formatVal(p.refAllele ?? p.ref ?? variant.refAllele ?? variant.ref ?? null);
              out['Alt Allele'] = formatVal(alt ?? null);
              out['_position_index'] = posIdx;
              out['_variant_index'] = varIdx;
              out['_transcript_index'] = tIdx;
              out['_alt_index'] = altIdx;

              // copy transcript primitive fields
              Object.keys(tr).forEach(k => {
                if (!isComplex(tr[k])) out[k] = formatVal(tr[k]);
              });

              // include variant-level primitive fields and flatten clinvar-like nested fields
              addVariantLevelToOut(variant, out);

              // flatten position-level samples for transcript rows too (same rules as above),
              // but insert them immediately after Chromosome/Position by adding now (they won't overwrite transcript fields)
              if (p.samples) {
                const samplesArr = Array.isArray(p.samples) ? p.samples : (typeof p.samples === 'object' ? Object.values(p.samples) : []);
                const samplesCount = samplesArr.length;
                samplesArr.forEach((s, si) => {
                  if (s && typeof s === 'object') {
                    Object.keys(s).forEach(sk => {
                      if (isComplex(s[sk]) || isDateKey(sk) || isDateValue(s[sk])) return;
                      let sval = s[sk];
                      if (Array.isArray(sval) && sval.every(item => item !== null && typeof item !== 'object')) {
                        const keyNorm = String(sk).toLowerCase();
                        if (keyNorm.includes('variantfrequency')) {
                          sval = sval.length ? sval[0] : null;
                        } else {
                          sval = sval.join(', ');
                        }
                      }
                      const formatted = formatVal(sval);
                      if (formatted !== null && formatted !== undefined) {
                        const col = mapSampleFieldName(sk, si, samplesCount);
                        if (out[col] === undefined) {
                          out[col] = formatted;
                          sampleKeySet.add(col);
                        }
                      }
                    });
                  }
                });
              }

              // collect gene rows for transcript entries (do not inline into transcript row)
              if (variant.genes) {
                const gArr = Array.isArray(variant.genes) ? variant.genes : [variant.genes];
                gArr.forEach(gobj => {
                  const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx, _variant_index: varIdx, _transcript_index: tIdx };
                  flattenFields('Gene', gobj, geneRow, geneKeySet);
                  if (Object.keys(geneRow).length > 4) extraRows.push(geneRow);
                });
              }
              if (variant.gene) {
                const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx, _variant_index: varIdx, _transcript_index: tIdx };
                flattenFields('Gene', variant.gene, geneRow, geneKeySet);
                if (Object.keys(geneRow).length > 4) extraRows.push(geneRow);
              }
              if (pGenes) {
                const pgArr = Array.isArray(pGenes) ? pGenes : [pGenes];
                pgArr.forEach(gobj => {
                  const geneRow = { Chromosome: out['Chromosome'], Position: out['Position'], _position_index: posIdx, _variant_index: varIdx, _transcript_index: tIdx };
                  flattenFields('Gene', gobj, geneRow, geneKeySet);
                  if (Object.keys(geneRow).length > 4) extraRows.push(geneRow);
                });
              }

              // include position primitive fields if not already set
              Object.keys(p).forEach(k => {
                if (!(k in out) && !isComplex(p[k])) out[k] = formatVal(p[k]);
              });

              rows.push(out);
            });
          });
        }
      });
    });

    // append collected gene/sample extra rows at the end
    if (extraRows.length) extraRows.forEach(er => rows.push(er));

    // Build final keys: extras first, then transcript keys, then any other keys from first row
    const extras = ['S No.', 'Chromosome', 'Alt Allele', 'Ref Allele', 'Position'];
    const transcriptKeys = Array.from(transcriptKeySet);
    const otherKeys = [];
    if (rows.length > 0) {
      Object.keys(rows[0]).forEach(k => {
        if (!extras.includes(k) && !transcriptKeys.includes(k)) otherKeys.push(k);
      });
      rows.forEach(r => Object.keys(r).forEach(k => {
        if (!extras.includes(k) && !transcriptKeys.includes(k) && !otherKeys.includes(k)) otherKeys.push(k);
      }));
    }

    // place sample columns immediately after extras (Chromosome/Position) by inserting sampleKeySet before transcripts
    const geneKeys = Array.from(geneKeySet);
    const sampleKeys = Array.from(sampleKeySet);
    // order: extras -> gene columns -> sample columns -> transcript columns -> other discovered keys
    const keysOrdered = Array.from(new Set([...extras, ...geneKeys, ...sampleKeys, ...transcriptKeys, ...otherKeys]));

    return { keys: keysOrdered, rows };
  };

  const renderCell = (val) => {
    // treat null/undefined/empty-string/empty-object/empty-array or complex values as hyphen
    if (val === null || val === undefined) return '-';
    if (typeof val === 'string' && val.trim() === '') return '-';
    // arrays: if contains objects -> treat as no-value; otherwise join primitives
    if (Array.isArray(val)) {
      if (val.some(item => item !== null && typeof item === 'object')) return '-';
      return val.length ? val.join(', ') : '-';
    }
    if (typeof val === 'object') {
      // skip showing raw objects
      return '-';
    }
    return String(val);
  };

  const renderTable = (value) => {
    // get original keys and rows
    const { keys: origKeys, rows } = normalizeToTable(value);

    // desired headers to appear first
    const extra = ['S No.', 'Chromosome', 'Alt Allele', 'Ref Allele', 'Position'];

    // helper: map common variants to a canonical column name
    const canonicalName = (k) => {
      if (k == null) return k;
      const s = String(k).trim();
      const norm = s.replace(/\s+/g, '').toLowerCase();
      const map = {
        chromosome: 'Chromosome',
        chromosomes: 'Chromosome',
        chr: 'Chromosome',
        'altallele': 'Alt Allele',
        'altalleles': 'Alt Allele',
        alt: 'Alt Allele',
        'refallele': 'Ref Allele',
        ref: 'Ref Allele',
        position: 'Position',
        pos: 'Position',
        'sno': 'S No.',
        'sno.': 'S No.'
      };
      return map[norm] ?? s;
    };

    // build ordered, deduped canonical keys (extras first)
    const ordered = [];
    const seen = new Set();
    [...extra, ...origKeys].forEach(k => {
      const c = canonicalName(k);
      if (!seen.has(c)) {
        ordered.push(c);
        seen.add(c);
      }
    });

    // Normalize rows to canonical keys (merge synonyms into one column)
    const normalizedRows = rows.map(row => {
      const out = {};
      Object.keys(row).forEach(origK => {
        const c = canonicalName(origK);
        // prefer existing non-null value, otherwise set
        if (out[c] === undefined || out[c] === null) out[c] = row[origK];
      });
      return out;
    });

    // include any keys present in rows but not in ordered (preserve order encountered)
    normalizedRows.forEach(r => {
      Object.keys(r).forEach(k => {
        if (!seen.has(k)) {
          ordered.push(k);
          seen.add(k);
        }
      });
    });

    const keys = ordered;

    if (keys.length === 0) return <div style={{ color: '#666' }}>No data to display in table.</div>;

    return (
      // changed: make this wrapper the scrolling container so sticky headers work
      <div style={{ width: '100%', maxHeight: 'calc(100vh - 250px)', overflowY: 'auto', overflowX: 'auto', position: 'relative' }}>
        <table
          className="json-table"
          style={{
            width: '100%',
            minWidth: 800,
          }}
        >
          <thead>
            <tr>
              {keys.map(k => (
                <th
                  key={k}
                  style={{
                    textAlign: 'center',
                    borderBottom: '1px solid #ddd',
                    padding: '6px 8px',
                    background: '#fafafa',
                    position: 'sticky',
                    top: 0,
                    zIndex: 3,
                    backgroundClip: 'padding-box'
                  }}
                >
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {normalizedRows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f1f1f1' }}>
                {keys.map(k => (
                  <td
                    key={k + i}
                    style={{
                      padding: '6px 8px',
                      verticalAlign: 'top',
                      whiteSpace: 'normal',
                    }}
                  >
                    {k === 'S No.' ? (i + 1) : renderCell(row[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // export visible table to xlsx using same header normalization as renderTable
  const exportToExcel = () => {
    if (!data) return;
    setLoading(true);
    const { keys: origKeys, rows } = normalizeToTable(data);

    // canonicalName same as renderTable
    const canonicalName = (k) => {
      if (k == null) return k;
      const s = String(k).trim();
      const norm = s.replace(/\s+/g, '').toLowerCase();
      const map = {
        chromosome: 'Chromosome',
        chromosomes: 'Chromosome',
        chr: 'Chromosome',
        'altallele': 'Alt Allele',
        'altalleles': 'Alt Allele',
        alt: 'Alt Allele',
        'refallele': 'Ref Allele',
        ref: 'Ref Allele',
        position: 'Position',
        pos: 'Position',
        'sno': 'S No.',
        'sno.': 'S No.'
      };
      return map[norm] ?? s;
    };

    const extra = ['S No.', 'Chromosome', 'Alt Allele', 'Ref Allele', 'Position'];
    const ordered = [];
    const seen = new Set();
    [...extra, ...origKeys].forEach(k => {
      const c = canonicalName(k);
      if (!seen.has(c)) {
        ordered.push(c);
        seen.add(c);
      }
    });

    // normalize rows to canonical keys
    const normalizedRows = rows.map(row => {
      const out = {};
      Object.keys(row).forEach(origK => {
        const c = canonicalName(origK);
        if (out[c] === undefined || out[c] === null) out[c] = row[origK];
      });
      return out;
    });

    normalizedRows.forEach(r => {
      Object.keys(r).forEach(k => {
        if (!seen.has(k)) { ordered.push(k); seen.add(k); }
      });
    });

    const headers = ordered;
    const aoa = [headers];
    normalizedRows.forEach((r, idx) => {
      const rowArr = headers.map(h => {
        if (h === 'S No.') return idx + 1;
        const v = r[h];
        // reuse renderCell formatting where appropriate (replace '-' for no value)
        if (v === null || v === undefined) return '-';
        if (Array.isArray(v)) {
          if (v.some(item => item !== null && typeof item === 'object')) return '-';
          return v.join(', ');
        }
        if (typeof v === 'object') return '-';
        return v;
      });
      aoa.push(rowArr);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    // build download name from uploaded file name; default to export.xlsx
    const outName = fileName ? (String(fileName).replace(/\.[^/.]+$/, '') + '.xlsx') : 'export.xlsx';
    XLSX.writeFile(wb, outName);
    setLoading(false);
  };

  return (
    <div className="App" style={{ padding: 20, fontFamily: 'sans-serif' }}>
      {/* Loading overlay */}
      {loading && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(255,255,255,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{ textAlign: 'center' }}>
            <style>{`
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}</style>
            <svg
              width="48"
              height="48"
              viewBox="0 0 50 50"
              aria-hidden
              style={{ transformOrigin: '50% 50%', animation: 'spin 0.9s linear infinite' }}
            >
              <circle cx="25" cy="25" r="20" stroke="#ff6900" strokeWidth="4" fill="none" strokeDasharray="31.4 31.4" />
            </svg>
            <div style={{ marginTop: 8, color: '#ff6900', fontWeight: 600 }}>Loading…</div>
          </div>
        </div>
      )}

      <h2>JSON Input & Viewer</h2>

      <div style={{ margin: '0 auto' }}>
        {/* Input area */}
        <div style={{ marginBottom: 12 }}>
          <label><strong>Load JSON</strong></label>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="file" accept=".json,.json.gz,application/json,application/gzip" onChange={handleFileChange} />
            <button onClick={handleClear}>Clear</button>
            <button onClick={exportToExcel} disabled={!data}>Export .xlsx</button>
            {/* <button onClick={() => convertGzToJson()} disabled={!lastFile}>Download JSON</button> */}
            <small style={{ color: '#666' }}>Choose a .json file to render the table</small>
          </div>
          {error && <div style={{ color: 'crimson', marginTop: 8 }}>Error: {error}</div>}
        </div>

        {/* Table area */}
        <div>
          <label><strong>Table</strong></label>
          <div
            style={{
              marginTop: 8,
              border: '1px solid #ddd',
              padding: 8,
              borderRadius: 4,
              maxHeight: 'calc(100vh - 250px)', // adjust based on viewport
              overflow: 'auto',            // vertical + horizontal as needed inside this box
              background: '#fff'
            }}
          >
            {data === null
              ? <div style={{ color: '#666' }}>No data loaded. Load a .json file to render the table.</div>
              : renderTable(data)
            }
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
