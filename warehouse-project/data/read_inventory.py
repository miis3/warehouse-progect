import zipfile,xml.etree.ElementTree as E,json
z=zipfile.ZipFile('/workspace/scratch/e9c50c07acd7/upload/R-A.xlsx')
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
strings=[''.join(x.itertext()) for x in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',n)]
rels={x.attrib['Id']:x.attrib['Target'] for x in E.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
data=[]
for s in E.fromstring(z.read('xl/workbook.xml')).findall('m:sheets/m:sheet',n):
 p=rels[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]; root=E.fromstring(z.read('xl/'+p)); rows=[]
 for r in root.findall('m:sheetData/m:row',n):
  cells={}
  for c in r.findall('m:c',n):
   v=c.find('m:v',n); t=c.attrib.get('t'); value=v.text if v is not None else ''
   if t=='s' and value:value=strings[int(value)]
   if t=='inlineStr':value=''.join(c.find('m:is',n).itertext())
   if value:cells[c.attrib['r']]=value
  if cells:rows.append(cells)
 data.append({'sheet':s.attrib['name'],'rows':rows,'merges':[x.attrib['ref'] for x in root.findall('m:mergeCells/m:mergeCell',n)],'formulas':[(c.attrib['r'],c.find('m:f',n).text) for c in root.findall('.//m:c',n) if c.find('m:f',n) is not None]})
if __name__=='__main__':
 import sys
 mode=sys.argv[1] if len(sys.argv)>1 else 'summary'
 for d in data:
  if mode=='summary':print(json.dumps({'sheet':d['sheet'],'rows':len(d['rows']),'head':d['rows'][:12],'tail':d['rows'][-2:],'formulas':d['formulas'][:3]},ensure_ascii=False))
  elif mode=='all' or mode==d['sheet']:print(json.dumps(d,ensure_ascii=False))
