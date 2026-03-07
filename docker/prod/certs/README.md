# Using development (self-signed) SSL certificates

In order to work in local development environment you need to import self-signed root CA certificate (named `ca.crt`) in Trusted Root Certification Authorities database for your respective browser and/or operating system.
After root CA is imported, you can use any number of local certificates for different domains without browser reporting it as invalid. 

Currently supported domains in `local.io.crt` (used in Docker dev environment setup):
- local.io
- *.local.io

_Wildcard includes only one subdomain level_  

_Both certificates expire on 2031-07-12_

## How to import the root CA in your browser/OS

You only need to perform this step **once** for each browser, whatever the number of certificates/domains you'll use.

### Edge & Chrome on Windows 10

- open `certmgr.msc`
- expand "Trusted Root Certification Authorities"
- right-click on "Certificates", then "All Tasks" > "Import..."
- click "Next"
- choose the `ca.crt` file
- click "Next" then "Finish"

### Chrome on Linux

- go to `chrome://settings/certificates`
- click the "Authorities" tab
- click "Import"
- select the `ca.crt` file
- check "Trust this certificate for identifying websites"
- click "OK"

### Firefox on Windows & Linux

- go to `about:preferences#privacy`
- scroll down to "Certificates"
- click "View Certificates..."
- click "Import..."
- select the `ca.crt` file
- check "Trust this CA to identify websites"
- click "OK"


_Based on work from https://github.com/BenMorel/dev-certificates_
